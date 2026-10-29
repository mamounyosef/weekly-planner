// ─── Tasks ───────────────────────────────────────────────────────────────────
// A place of their own, rather than whatever was left at the bottom of a day.
//
// WHY BUCKETS AND NOT A LIST
// "What do I still have to do" is a question about lateness, not about dates. A
// flat list sorted by due date buries the two things that matter, what is
// already late and what is due now, under everything that is merely coming.
// So the screen is grouped exactly the way the PC groups its own filters:
//
//   OVERDUE    late. First, loudest, and impossible to scroll past.
//   TODAY      due now.
//   ── a thick line: above it is what is on your plate now ──
//   TOMORROW / UPCOMING   has a date, later.
//   NO DATE    no date at all. Not late, not urgent, not lost either.
//   COMPLETED  folded away, because finished work should be findable but quiet.
//
// The screen is laid out like the PC's Tasks panel on purpose (header, list
// chips, date chips with counts, an add line, collapsible sections, small
// tiles with pills), so moving between the two needs no relearning.
//
// The buckets come from `taskBucket` in the shared library, so the phone and the
// PC can never disagree about what "overdue" means.
//
// LISTS ARE A FILTER, NOT A SIXTH BUCKET. A list answers "which part of my life
// is this", which is a different question from "how late is it". Nesting one
// inside the other would double the number of headings on a screen whose whole
// point is that you can see the top of it at a glance, so the lists live in one
// strip at the top and the buckets stay exactly as they were.
//
// SUBTASKS ARE DRAWN INSIDE THEIR PARENT'S CARD, one level deep and never more.
// A step of a task is not a task competing for the same attention, and giving it
// its own card in its own bucket is what made the PC's early version unreadable.
// A subtask therefore takes its parent's place in the buckets: only root tasks
// are sorted into Overdue / Today / Upcoming, and a step rides along with the
// thing it belongs to even when its own date says something else.
//
// ORDER IS OPT-IN. Nothing has an `order` until somebody moves something, and a
// group where nothing has one falls back to the date rule below, so the screen
// looks identical until the first move.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Image, Modal, Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Text, useTheme } from '../ui/kit';
import { ICONS } from '../ui/icons';
import { TextField } from '../ui/Fields';
import { ListChips } from '../ui/ListChips';
import { SortableList, SortableScrollView, type DragHandle } from '../ui/SortableList';
import { Tick } from '../ui/Tick';
import { PRESSED, PRESS_DELAY, TAP_DELAY, radius, space } from '../theme';
import { prefs } from '../lib/prefs';
import { usePlanner } from '../state/planner';
import { Editor, type EditorTarget } from './Editor';
import {
  ALL_TASK_FILTERS, TASK_FILTER_LABELS, dueDateOf, isStepDone, stepDoneChanges, type Task,
} from '../lib/tasks';
import { GENERAL_LIST_ID, resolveListId, type TaskList } from '../lib/taskLists';
import {
  buildTaskRows, groupTasks, nowDividerAfter, DEFAULT_SORT_MODE, SORT_MODES,
  type Node, type Row as BoardRow, type SectionKey, type SortMode,
} from '../lib/taskBoard';
import { planAppendOrder, planReorder } from '../lib/dragSort';
import { setLiveTaskFilters } from '../lib/agent/taskView';
import { planTick, setPending, isPending as heldDone } from '../lib/pendingDone';
import type { TaskFilter } from '../lib/tasks';

import { formatClock, ymd } from '../lib/agenda';
import { fromTimeString } from '../lib/draft';
import { useNowMinute } from '../ui/useNow';
import { TAB_STACK_BOTTOM_INSET } from '../ui/TabBar';

/** How long a ticked row stays where it is, so the tick can be seen. */
const DONE_HOLD_MS = 300;

/** How long a drag is believed if the write it started never comes back. */
const ORDER_GUESS_TTL_MS = 4000;

/**
 * The store as the user has just dragged it, without touching the store.
 *
 * Returns the SAME object when there is nothing to guess, so the board's memo
 * is not invalidated by an empty map.
 */
function applyOrderGuess(
  stored: Record<string, Task>,
  guess: Record<string, number>,
): Record<string, Task> {
  const ids = Object.keys(guess);
  if (ids.length === 0) return stored;
  const out = { ...stored };
  for (const id of ids) {
    const task = stored[id];
    if (!task || task.order === guess[id]) continue;
    out[id] = { ...task, order: guess[id] };
  }
  return out;
}

// The section keys and the shape of a card's contents both come from
// `taskBoard.ts` now. There used to be a second set of them here, in lower case
// and holding bare tasks instead of rows, which is why the card had to be handed
// a stripped-down copy of what the board had already worked out and could not
// tell which DAY of a repeat one of its steps belonged to.

const ORDER: { key: SectionKey; title: string }[] = [
  { key: 'Overdue', title: 'Overdue' },
  { key: 'Today', title: 'Today' },
  { key: 'Tomorrow', title: 'Tomorrow' },
  { key: 'Upcoming', title: 'Upcoming' },
  { key: 'No Date', title: 'No Date' },
  { key: 'Done', title: 'Completed' },
];

// The rule that a task nobody has placed sorts AFTER the ones somebody has now
// lives in `taskBoard.ts` as `orderKey`, next to the comparators that use it.
// It was written out here, correctly, with a comment explaining the exact bug it
// prevents -- and then never called, while the board went on reading an absent
// order as zero and dropping new tasks on top of arranged ones.

export function Tasks() {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { tasks, syncNow, edit, editMany, saveDraft, removeItem, timeFormat, taskLists } = usePlanner();

  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  // Which sections are folded. Completed starts folded, as on the PC.
  const [collapsed, setCollapsed] = useState<Partial<Record<SectionKey, boolean>>>({ Done: true });
  const [showSortMenu, setShowSortMenu] = useState(false);
  // The saved selection, as stored. Lists that don't exist (yet) are ignored
  // where it is used (`activeListIds` below) but never pruned from here: the
  // real lists can arrive after the first paint, and pruning then wiped the
  // remembered selection on every launch.
  const [storedListIds, setActiveListIds] = useState<string[]>([]);
  /** Which task, if any, has its "add a step" line open. */
  const [composingFor, setComposingFor] = useState<string | null>(null);
  const [sortMode, setSortModeState] = useState<SortMode>(DEFAULT_SORT_MODE);
  // The stored mode arrives a tick or two after the first paint. If the user
  // has already chosen one by then (a drag switches to Manual on its own), the
  // stored value is stale the moment it lands and must not be applied.
  const sortTouched = useRef(false);
  useEffect(() => {
    void prefs.getTaskSort().then(mode => {
      if (!sortTouched.current) setSortModeState(mode);
    });
  }, []);
  // Saved only after the stored value has been read: saving the initial []
  // first is what erased it.
  const listFilterLoaded = useRef(false);
  useEffect(() => {
    void prefs.getTaskListFilter().then(ids => {
      listFilterLoaded.current = true;
      setActiveListIds(prev => (prev.length ? prev : ids));
    });
  }, []);
  useEffect(() => {
    if (!listFilterLoaded.current) return;
    void prefs.setTaskListFilter(storedListIds);
  }, [storedListIds]);
  const setSortMode = (mode: SortMode) => {
    sortTouched.current = true;
    setSortModeState(mode);
    void prefs.setTaskSort(mode);
  };
  const [filters, setFilters] = useState<TaskFilter[]>([]);
  // The assistant is told what this screen shows (see lib/agent/taskView.ts).
  useEffect(() => { setLiveTaskFilters(filters); }, [filters]);

  /**
   * Things the user has just ticked, before the store has been told.
   *
   * A tick used to write straight through, which meant the row jumped into Done
   * in the same frame the box filled in: no tick to look at, and any work the
   * write set off (regrouping the board, replanning alarms, a sync) landed
   * between the finger and the paint. So the box is filled from HERE the moment
   * it is tapped, the row stays exactly where it is for a beat, and the real
   * write happens after. Tapping again inside that beat cancels it outright and
   * nothing is ever written, which is the cheapest undo there is.
   *
   * Un-ticking is not delayed. Nobody needs to admire that.
   */
  /**
   * The order the user has just dragged things into, before the store has it.
   *
   * WITHOUT THIS A DROP LOOKS BROKEN. The row is under the finger at its new
   * place, the finger lifts, the drag lets go -- and the list still holds the
   * OLD order, so the row snaps back to where it came from and only arrives
   * where it was dropped once the writes have gone through. Three positions for
   * one gesture.
   *
   * So the new numbers are believed here first and folded into the board in the
   * same frame the finger lifts. They are dropped again the moment the store
   * agrees, which is the ordinary case a few milliseconds later, and after a
   * few seconds regardless so that a write which never landed shows the truth.
   */
  const [orderGuess, setOrderGuess] = useState<Record<string, number>>({});
  const orderGuessTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (orderGuessTimer.current) clearTimeout(orderGuessTimer.current);
  }, []);

  const [pendingDone, setPendingDone] = useState<Record<string, boolean>>({});
  const doneTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  /** The write each held tick is waiting to make. */
  const doneWrites = useRef<Record<string, () => void>>({});
  useEffect(() => () => {
    // FLUSHED, NOT CANCELLED. The screen going away while a tick is held is
    // still the user having ticked something, and dropping the timer here would
    // be a tap that silently did nothing.
    Object.values(doneTimers.current).forEach(t => clearTimeout(t));
    doneTimers.current = {};
    const outstanding = Object.values(doneWrites.current);
    doneWrites.current = {};
    outstanding.forEach(write => write());
  }, []);


  /**
   * A CLOCK, not a reading taken once.
   *
   * This was `todayYmd()` during render, with nothing to re-render it. Tabs are
   * kept mounted, so a phone left on this screen overnight went on sorting
   * against yesterday: nothing moved into Overdue, tomorrow's work stayed under
   * "Tomorrow", and the count in the header was wrong until something unrelated
   * happened to cause a render. The calendar solved exactly this and said so --
   * reading the clock during render "is not a clock, it is a coincidence".
   */
  const now = useNowMinute();
  const today = ymd(now);

  const lists = useMemo<TaskList[]>(() => (
    (taskLists as any[])
      .filter(l => l && typeof l === 'object' && typeof l.id === 'string')
      .map(l => ({ id: l.id, name: String(l.name ?? 'Untitled'), color: String(l.color ?? '') }))
  ), [taskLists]);

  const activeListIds = useMemo(
    () => storedListIds.filter(id => lists.some(l => l.id === id)),
    [storedListIds, lists],
  );
  // Single selected list, when exactly one is chosen: used where only one makes
  // sense (filing a new task, badge colour). Null otherwise.
  const filter: string | null = activeListIds.length === 1 ? activeListIds[0] : null;

  // Only worth a strip when there is a choice to make: a planner with nothing
  // but General has one possible answer, and a filter with one option is noise.
  const showChips = lists.filter(l => l.id !== GENERAL_LIST_ID).length > 0;

  
  const board = useMemo(() => {
    const stored = tasks() as unknown as Record<string, Task>;
    // Only the rows that were dragged are copied; the rest of the store is the
    // same objects it always was.
    const rawTasks = applyOrderGuess(stored, orderGuess);
    const rows = buildTaskRows(rawTasks, today, true);
    const shown = groupTasks(rows, rawTasks, lists, activeListIds, filters, today, sortMode);
    // THE SAME BUCKETS WITH NO LIST FILTER, so a drag can be expressed against
    // the whole arrangement rather than against the slice of it on screen. See
    // `moveItem`. Computed only when a filter is actually on: with no filter the
    // two are the same thing, and grouping twice for nothing is the sort of cost
    // that turns into a stutter on a long list.
    return {
      shown,
      whole: activeListIds.length ? groupTasks(rows, rawTasks, lists, [], filters, today, sortMode) : shown,
    };
  }, [tasks, today, activeListIds, lists, filters, sortMode, orderGuess]);

  const grouped = board.shown;

  // A guess the store has caught up with is dead weight: it makes every later
  // render copy rows for nothing.
  useEffect(() => {
    if (Object.keys(orderGuess).length === 0) return;
    const stored = tasks() as unknown as Record<string, Task>;
    const settled = Object.keys(orderGuess).every(id => stored[id]?.order === orderGuess[id]);
    if (settled) setOrderGuess({});
  }, [tasks, orderGuess]);


  
  const openNodes = grouped.Overdue.length + grouped.Today.length + grouped.Tomorrow.length + grouped.Upcoming.length + grouped['No Date'].length;

  const open = useMemo(() => {
    let n = 0;
    for (const key of ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'No Date'] as const) {
      for (const node of grouped[key]) {
        n += 1;
        n += node.children.filter(c => !c.done).length;
      }
    }
    return n;
  }, [grouped]);

  const nothingAtAll = openNodes === 0 && grouped.Done.length === 0;


  const refresh = async () => {
    setRefreshing(true);
    try { await syncNow(); } finally { setRefreshing(false); }
  };

  const isPending = (key: string) => heldDone(pendingDone, key);

  const clearPending = (key: string) => {
    const timer = doneTimers.current[key];
    if (timer) {
      clearTimeout(timer);
      delete doneTimers.current[key];
    }
    delete doneWrites.current[key];
    setPendingDone(prev => setPending(prev, key, false));
  };

  /**
   * Exactly what a tick box is aimed at.
   *
   * `parent` is null for a task in its own right and the MASTER for a step. It
   * is not decoration: a step of something that repeats is done for one day
   * only, and the parent is the only thing that knows whether that is the case.
   */
  interface TickTarget {
    task: Task;
    parent: Task | null;
    occDate: string | null;
  }

  /** What the tick box is actually wired to. `toggle` below does the writing. */
  const toggleAnimated = (key: string, target: TickTarget) => {
    const stored = isStepDone(target.task, target.parent, target.occDate);
    const plan = planTick(stored, isPending(key));

    // 'write' is an un-tick, which is never held. 'cancel' is a second tap
    // inside the hold: forget it, and nothing is ever written.
    if (plan !== 'hold') {
      clearPending(key);
      if (plan === 'write') toggle(target);
      return;
    }

    setPendingDone(prev => setPending(prev, key, true));
    const existing = doneTimers.current[key];
    if (existing) clearTimeout(existing);

    const write = () => {
      delete doneTimers.current[key];
      delete doneWrites.current[key];
      toggle(target);
      // Same tick as the write, which commits synchronously, so the row never
      // flickers back to undone between the two.
      setPendingDone(prev => setPending(prev, key, false));
    };

    doneWrites.current[key] = write;
    doneTimers.current[key] = setTimeout(write, DONE_HOLD_MS);
  };

  const toggle = (target: TickTarget) => {
    // The rule lives in `tasks.ts`, shared with the PC. A tick that produced a
    // slightly different record on the two machines would be a field-level
    // merge conflict over something both of them agreed about.
    const changes = stepDoneChanges(target.task, target.parent, target.occDate);
    if (Object.keys(changes).length === 0) return;
    void edit('tasks', target.task.id, changes);
  };

  /**
   * Move one task a place up or down inside the group it is drawn in.
   *
   * The WHOLE group is renumbered rather than only the pair that swapped. Until
   * the first move most of these tasks have no `order` at all, and two numbers
   * floating among blanks would not survive the next sort. Renumbering is
   * cheap after that: only the rows whose number actually changed are written,
   * so a later swap costs two edits, not the group.
   *
   * The numbers are spaced ten apart, the same step the PC writes, so that a
   * move made on one machine leaves room for one made on the other.
   */
  /**
   * Apply a set of new positions: believe them now, write them once.
   *
   * The guess is what stops the row visiting three places for one gesture. It is
   * merged rather than replaced, because a drag in one section must not drop a
   * guess still outstanding for another.
   */
  const applyOrders = (changes: Array<{ id: string; order: number }>) => {
    if (changes.length === 0) return;

    const guess: Record<string, number> = {};
    for (const c of changes) guess[c.id] = c.order;
    setOrderGuess(prev => ({ ...prev, ...guess }));
    if (orderGuessTimer.current) clearTimeout(orderGuessTimer.current);
    orderGuessTimer.current = setTimeout(() => setOrderGuess({}), ORDER_GUESS_TTL_MS);

    // ONE write, not one per row. Five rows sent one at a time is five merges,
    // five commits and five sync pushes, and the list walks to its new order a
    // row at a time.
    void editMany('tasks', changes.map(c => ({ id: c.id, changes: { order: c.order } })));
  };

  /**
   * Move one task inside the group it is drawn in.
   *
   * `whole` is the bucket with no list filter on it; `visible` is what the user
   * can actually see, and what the two indices refer to. THE TWO ARE NOT THE
   * SAME LIST, and that distinction is the whole point: renumbering only what
   * was on screen gave the Work list 0, 10, 20 -- and the Home list 0, 10, 20,
   * and Errands 0, 10, 20 -- so clearing the filter interleaved three separate
   * arrangements into one nobody had chosen. Every drag made under a filter was
   * quietly wrecking the other lists.
   *
   * The numbers are spaced ten apart, the same step the PC writes, so that a
   * move made on one machine leaves room for one made on the other.
   */
  const moveItem = (whole: Task[], visible: Task[], fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const plan = planReorder(whole, visible, fromIndex, toIndex);
    applyOrders(plan.changes);
    // A drag is a statement about where a thing goes, and in any other sort
    // mode the board would answer it by putting everything straight back. The
    // PC switches to manual on a drag for the same reason.
    if (sortMode !== 'manual') setSortMode('manual');
  };

  /**
   * Add a step under a task.
   *
   * It inherits the parent's day rather than today's, so a step of something due
   * on Friday does not quietly appear in Today on the PC -- and a parent with no
   * date passes that on too, rather than dropping its steps onto today.
   */
  const addSubtask = async (parent: Task, title: string, siblings: Task[]) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    // A step inherits its parent's day, INCLUDING not having one. Filing the
    // steps of an undated task on today would scatter them across the calendar
    // while the thing they belong to sits outside it.
    const parentDue = dueDateOf(parent);
    // ONE PAST THE LAST ONE, not "how many are there". Counting gave the third
    // step the number 2, which lands it second the moment the steps have been
    // dragged into 0, 10, 20: a new step wedged into the middle of the list it
    // was meant to join the end of.
    const place = planAppendOrder(siblings);
    const id = await saveDraft('tasks', {
      title: trimmed,
      date: parentDue ?? today,
      undated: !parentDue,
      allDay: true,
      startMin: null,
      endMin: null,
    });
    await edit('tasks', id, {
      parentId: parent.id,
      order: place.order,
      // Only written when there is one: filing a step on "no list" explicitly
      // would be an edit that says nothing, and the parent is what decides.
      ...(parent.listId ? { listId: parent.listId } : {}),
    });
    // Siblings that had never been placed, numbered in the order they were being
    // drawn, so that "the end" is a place that exists.
    if (place.changes.length > 0) {
      void editMany('tasks', place.changes.map(c => ({ id: c.id, changes: { order: c.order } })));
    }
  };

  // ── Counts for the chips, the same numbers the PC panel shows ──
  // Lists count everything open; the date chips count what the selected lists
  // hold, before the date filters themselves narrow it.
  const chipCounts = useMemo(() => {
    const stored = tasks() as unknown as Record<string, Task>;
    const rows = buildTaskRows(stored, today, true);
    const everything = groupTasks(rows, stored, lists, [], [], today, sortMode);
    const inLists = activeListIds.length
      ? groupTasks(rows, stored, lists, activeListIds, [], today, sortMode)
      : everything;
    const perList: Record<string, number> = {};
    let all = 0;
    for (const key of OPEN_KEYS) {
      for (const node of everything[key]) {
        all += 1;
        const id = resolveListId(node.row.task.listId, lists);
        perList[id] = (perList[id] ?? 0) + 1;
      }
    }
    const byFilter: Record<TaskFilter, number> = {
      today: inLists.Today.length,
      overdue: inLists.Overdue.length,
      upcoming: inLists.Tomorrow.length + inLists.Upcoming.length,
      general: inLists['No Date'].length,
      completed: inLists.Done.length,
    };
    return { all, perList, byFilter };
  }, [tasks, today, lists, activeListIds, sortMode]);

  const dividerAfter = nowDividerAfter({
    Overdue: grouped.Overdue.length,
    Today: grouped.Today.length,
    Tomorrow: grouped.Tomorrow.length,
    Upcoming: grouped.Upcoming.length,
    'No Date': grouped['No Date'].length,
    Done: grouped.Done.length,
  });

  // The list pill on a card, General included, exactly when the PC shows one:
  // whenever more than one list is on screen.
  const showListBadge = activeListIds.length !== 1 && lists.length > 1;
  const listBadgeOf = (t: Task): TaskList | null => {
    if (!showListBadge) return null;
    const id = resolveListId(t.listId, lists);
    return lists.find(l => l.id === id) ?? null;
  };

  const headerTitle = activeListIds.length === 0
    ? 'Tasks'
    : activeListIds.length === 1
      ? (lists.find(l => l.id === activeListIds[0])?.name ?? 'Tasks')
      : `${activeListIds.length} Lists`;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        {/* Title row: the same shape as the PC panel's header. */}
        <Row style={{ paddingHorizontal: space.lg, alignItems: 'center', gap: space.md }}>
          <View style={{
            width: 34, height: 34, borderRadius: 10,
            alignItems: 'center', justifyContent: 'center',
            backgroundColor: p.accentSoft, borderWidth: 1, borderColor: p.line,
          }}>
            <Image source={{ uri: ICONS['check-square'] }} style={{ width: 17, height: 17, tintColor: p.accent }} />
          </View>
          <View style={{ flex: 1 }}>
            <Row gap={space.sm} style={{ alignItems: 'center' }}>
              <Text variant="heading" numberOfLines={1} style={{ flexShrink: 1 }}>{headerTitle}</Text>
              {open > 0 ? (
                <View style={{ minWidth: 20, paddingHorizontal: 6, height: 20, borderRadius: 10, backgroundColor: p.accent, alignItems: 'center', justifyContent: 'center' }}>
                  <Text variant="label" style={{ color: p.accentInk, letterSpacing: 0 }}>{open}</Text>
                </View>
              ) : null}
            </Row>
            <Text variant="caption" tone="faint" style={{ fontSize: 12 }}>
              {open === 0 ? 'Nothing outstanding' : `${openNodes} shown`} · {lists.length} {lists.length === 1 ? 'list' : 'lists'}
            </Text>
          </View>
          <Pressable
            unstable_pressDelay={PRESS_DELAY}
            onPress={() => setShowSortMenu(true)}
            accessibilityRole="button"
            accessibilityLabel={`Sort: ${SORT_LABELS[sortMode]}`}
            style={({ pressed }) => [{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 10, height: 32, borderRadius: 9,
              backgroundColor: p.surfaceAlt, borderWidth: 1, borderColor: p.line,
            }, pressed ? PRESSED : null]}
          >
            <Image source={{ uri: ICONS['arrow-up-down'] }} style={{ width: 13, height: 13, tintColor: p.inkSoft }} />
            <Text variant="caption" tone="soft" style={{ fontSize: 12, fontWeight: '600' }}>{SORT_LABELS[sortMode]}</Text>
            <Image source={{ uri: ICONS['chevron-down'] }} style={{ width: 12, height: 12, tintColor: p.inkFaint }} />
          </Pressable>
        </Row>

        {/* Lists. */}
        {showChips ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.md, gap: space.sm }}>
            <Chip
              label="All"
              count={chipCounts.all}
              active={activeListIds.length === 0}
              onPress={() => setActiveListIds([])}
            />
            {lists.map(l => {
              const on = activeListIds.includes(l.id);
              return (
                <Chip
                  key={l.id}
                  label={l.name}
                  dot={l.color || p.ok}
                  count={chipCounts.perList[l.id] ?? 0}
                  active={on}
                  onPress={() => setActiveListIds(prev =>
                    prev.includes(l.id) ? prev.filter(x => x !== l.id) : [...prev, l.id]
                  )}
                />
              );
            })}
          </ScrollView>
        ) : null}

        {/* Dates, like the PC's filter row. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm }}>
          <Chip label="All" active={filters.length === 0} check onPress={() => setFilters([])} />
          {ALL_TASK_FILTERS.map(f => {
            const active = filters.includes(f);
            return (
              <Chip
                key={f}
                label={TASK_FILTER_LABELS[f]}
                count={chipCounts.byFilter[f]}
                active={active}
                check
                danger={f === 'overdue'}
                onPress={() => setFilters(active ? filters.filter(x => x !== f) : [...filters, f])}
              />
            );
          })}
        </ScrollView>

        {/* Add a task: the PC's composer line. It opens the full editor. */}
        <View style={{ paddingHorizontal: space.lg, paddingVertical: space.md }}>
          <Pressable
            unstable_pressDelay={TAP_DELAY}
            onPress={() => setEditing({ store: 'tasks', date: today, listId: filter ?? undefined })}
            accessibilityRole="button"
            accessibilityLabel="Add a task"
            android_ripple={{ color: p.accentSoft }}
            style={({ pressed }) => [{
              flexDirection: 'row', alignItems: 'center', gap: space.sm,
              paddingHorizontal: space.md, height: 42, borderRadius: 12,
              backgroundColor: p.surface, borderWidth: 1.5, borderColor: p.line,
            }, pressed ? PRESSED : null]}
          >
            <Image source={{ uri: ICONS.plus }} style={{ width: 16, height: 16, tintColor: p.inkFaint }} />
            <Text variant="body" tone="faint" style={{ fontSize: 14 }}>Add a new task...</Text>
          </Pressable>
        </View>
      </View>

      <SortableScrollView
        contentContainerStyle={{
          paddingHorizontal: space.md,
          paddingTop: space.md,
          paddingBottom: TAB_STACK_BOTTOM_INSET + 40,
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.accent} />
        }
      >
        {nothingAtAll ? (
          <View style={{ paddingTop: space.xxl, alignItems: 'center', gap: space.sm }}>
            <Text variant="heading" tone="soft">
              {filter ? 'Nothing on this list' : 'No tasks yet'}
            </Text>
            <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 260 }}>
              {filter
                ? 'Anything you add while this list is selected lands here.'
                : 'Add one above, or on your PC. They meet in the middle.'}
            </Text>
          </View>
        ) : null}

        {ORDER.map(section => {
          const key = section.key as SectionKey;
          const nodes = grouped[key] ?? [];
          if (!nodes || nodes.length === 0) return null;

          const isCollapsed = !!collapsed[key];
          const visible = isCollapsed ? [] : nodes;
          const danger = key === 'Overdue';
          const dateLabel = key === 'Today' ? shortDate(today)
            : key === 'Tomorrow' ? shortDate(ymd(addDays(now, 1)))
              : null;

          return (
            <View key={key} style={{ marginBottom: space.sm }}>
              <Pressable
                unstable_pressDelay={PRESS_DELAY}
                onPress={() => setCollapsed(c => ({ ...c, [key]: !c[key] }))}
                accessibilityRole="button"
                accessibilityState={{ expanded: !isCollapsed }}
                style={({ pressed }) => [{ paddingVertical: space.sm, paddingHorizontal: space.xs }, pressed ? PRESSED : null]}
              >
                <Row gap={space.sm} style={{ alignItems: 'center' }}>
                  <Image
                    source={{ uri: ICONS['chevron-down'] }}
                    style={{ width: 14, height: 14, tintColor: p.inkFaint, transform: [{ rotate: isCollapsed ? '-90deg' : '0deg' }] }}
                  />
                  <Text variant="bodyStrong" style={{ fontSize: 14, color: danger ? p.danger : p.ink }}>
                    {section.title}
                  </Text>
                  {dateLabel ? (
                    <Text variant="caption" tone="faint" style={{ fontSize: 12 }}>{dateLabel}</Text>
                  ) : null}
                  <Text variant="caption" style={{ marginLeft: 'auto', fontSize: 12, color: danger ? p.danger : p.inkFaint }}>
                    {nodes.length}
                  </Text>
                </Row>
              </Pressable>

              {/* The gap belongs to the LIST, not to this wrapper: a wrapper's
                  gap sits between its own children, and it has exactly one. */}
              {visible.length > 0 ? (
                <View style={{ marginTop: 2 }}>
                  <SortableList
                    data={visible}
                    gap={6}
                    // Done is in the order things were FINISHED, which is not
                    // something to arrange. A drag there used to lift the row,
                    // carry it, drop it, and have the list put it straight back.
                    sortable={key !== 'Done'}
                    keyExtractor={n => n.row.occId}
                    onReorder={(fromIdx, toIdx) => moveItem(
                      (board.whole[key] ?? nodes).map(n => n.row.task),
                      visible.map(n => n.row.task),
                      fromIdx,
                      toIdx,
                    )}
                    renderItem={(node, _index, drag) => (
                      <TaskCard
                        node={node}
                        today={today}
                        clock={timeFormat}
                        list={listBadgeOf(node.row.task)}
                        showDate={key === 'Overdue' || key === 'Upcoming' || key === 'Done'}
                        drag={drag}
                        occKey={node.row.occId}
                        pending={isPending}
                        composing={composingFor === node.row.task.id}
                        onCompose={next => setComposingFor(next ? node.row.task.id : null)}
                        onAddSubtask={title => addSubtask(node.row.task, title, node.children.map(c => c.task))}
                        onMoveChild={(fromChild, toChild) => {
                          const steps = node.children.map(c => c.task);
                          moveItem(steps, steps, fromChild, toChild);
                        }}
                        onToggle={(row, k, parent) => toggleAnimated(k, {
                          task: row.task, parent, occDate: row.due,
                        })}
                        onOpen={t => setEditing({
                          store: 'tasks', id: t.id, date: t.id === node.row.task.id ? (node.row.due ?? today) : (dueDateOf(t) ?? today),
                        })}
                      />
                    )}
                  />
                </View>
              ) : null}

              {dividerAfter === key ? <NowDivider /> : null}
            </View>
          );
        })}
      </SortableScrollView>

      <Modal visible={showSortMenu} transparent animationType="fade" onRequestClose={() => setShowSortMenu(false)}>
        <Pressable style={{ flex: 1 }} onPress={() => setShowSortMenu(false)} accessibilityLabel="Close sort menu">
          <View style={{
            position: 'absolute', right: space.lg, top: insets.top + space.sm + 40,
            minWidth: 180, paddingVertical: 6, borderRadius: 12,
            backgroundColor: p.surfaceAlt, borderWidth: 1, borderColor: p.line,
            elevation: 12, shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 14, shadowOffset: { width: 0, height: 6 },
          }}>
            {SORT_MODES.map(mode => (
              <Pressable
                key={mode}
                unstable_pressDelay={PRESS_DELAY}
                onPress={() => { setSortMode(mode); setShowSortMenu(false); }}
                android_ripple={{ color: p.accentSoft }}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: 10 }}
              >
                <View style={{ width: 14 }}>
                  {sortMode === mode ? (
                    <Image source={{ uri: ICONS.check }} style={{ width: 14, height: 14, tintColor: p.accent }} />
                  ) : null}
                </View>
                <Text variant="body" style={{ fontSize: 14, color: sortMode === mode ? p.accent : p.ink }}>
                  {SORT_LABELS[mode]}
                </Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Modal>

      <Editor target={editing} onClose={() => setEditing(null)} />
    </View>
  );
}

const OPEN_KEYS = ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'No Date'] as const;

const SORT_LABELS: Record<SortMode, string> = {
  datetime: 'Date & Time',
  manual: 'Manual Order',
  title: 'Title (A-Z)',
  'title-desc': 'Title (Z-A)',
};

/** "Fri, Oct 23", as the PC writes a date. */
function shortDate(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function addDays(d: Date, n: number): Date {
  const next = new Date(d);
  next.setDate(next.getDate() + n);
  return next;
}

/**
 * The thick line under what is on your plate now (Overdue + Today), parting it
 * from everything later. Where it goes is `nowDividerAfter` (taskBoard.ts).
 */
function NowDivider() {
  const p = useTheme();
  return (
    <View
      accessibilityRole="none"
      accessibilityLabel="Later tasks below"
      style={{ paddingTop: space.md, paddingBottom: space.xs, paddingHorizontal: space.sm }}
    >
      <View style={{ height: 3, borderRadius: 2, backgroundColor: p.accent, opacity: 0.7 }} />
    </View>
  );
}

/** A pill in the list and date rows, drawn like the PC's filter chips. */
function Chip({ label, count, dot, active, danger, check, onPress }: {
  label: string;
  count?: number;
  dot?: string;
  active: boolean;
  danger?: boolean;
  /** Show a tick when on, as the PC's date chips do. */
  check?: boolean;
  onPress: () => void;
}) {
  const p = useTheme();
  const tone = danger ? p.danger : p.accent;
  return (
    <Pressable
      unstable_pressDelay={PRESS_DELAY}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => [{
        flexDirection: 'row', alignItems: 'center', gap: 6,
        paddingLeft: 10, paddingRight: count != null && count > 0 ? 5 : 10, height: 30, borderRadius: 15,
        backgroundColor: active ? `${tone}22` : p.surface,
        borderWidth: 1, borderColor: active ? tone : p.line,
      }, pressed ? PRESSED : null]}
    >
      {check && active ? (
        <Image source={{ uri: ICONS.check }} style={{ width: 11, height: 11, tintColor: tone }} />
      ) : null}
      {dot ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} /> : null}
      <Text variant="caption" style={{ fontSize: 12, fontWeight: '600', color: active ? tone : p.inkSoft }}>{label}</Text>
      {count != null && count > 0 ? (
        <View style={{
          minWidth: 20, height: 20, paddingHorizontal: 5, borderRadius: 10,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: active ? tone : p.surfaceAlt,
        }}>
          <Text variant="label" style={{ letterSpacing: 0, fontSize: 10, color: active ? p.accentInk : p.inkSoft }}>{count}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ─── One task, and its steps ─────────────────────────────────────────────────
// Drawn like a row of the PC's Tasks panel: a soft tile, the tick, the title,
// and a line of small pills (list, date, time, repeat, notes) under it. The
// card is still the unit: a task and its steps share one tile, so a glance
// separates "three things to do" from "one thing in three parts".

function TaskCard({
  node, today, clock, list, showDate, drag, composing, occKey, pending,
  onMoveChild, onToggle, onOpen, onCompose, onAddSubtask,
}: {
  node: Node;
  today: string;
  clock?: string;
  /** The list pill, or null when it would say nothing (one list on screen). */
  list: TaskList | null;
  /** The date pill, shown where the section does not already say the day. */
  showDate: boolean;
  drag: DragHandle;
  composing: boolean;
  /** What this row is keyed by while it waits to be written. */
  occKey: string;
  pending: (key: string) => boolean;
  onMoveChild: (fromIndex: number, toIndex: number) => void;
  /** The row that was ticked, its own hold key, and the master it belongs to. */
  onToggle: (row: BoardRow, key: string, parent: Task | null) => void;
  onOpen: (t: Task) => void;
  onCompose: (open: boolean) => void;
  onAddSubtask: (title: string) => Promise<void>;
}) {
  const p = useTheme();
  const task = node.row.task;
  const children = node.children;
  // THE ROW'S DATE, NOT THE TASK'S. For one occurrence of a repeat these are
  // different: the task record carries the series anchor, the row carries the
  // day being drawn.
  const due = node.row.due;
  // Optimistic on purpose: everything below reads "done" from what the user has
  // just done, not from what has been stored yet.
  const done = node.row.done || pending(occKey);
  const overdue = !done && !!due && due < today;
  // The tick takes the task's own colour, else red when late, else neutral,
  // as on the PC.
  const colour = task.color ?? (overdue ? p.danger : p.inkSoft);
  const startMin = task.startTime ? fromTimeString(task.startTime) : null;
  const doneKids = children.filter(c => c.done || pending(c.occId)).length;
  const hasNotes = Boolean((task.description || (task as any).notes)?.trim());
  const pills = !!list || (showDate && !!due) || startMin !== null || !!task.recur || hasNotes;

  return (
    <View style={{
      borderRadius: 14,
      backgroundColor: overdue ? `${p.danger}14` : p.surface,
      borderWidth: 1,
      borderColor: overdue ? `${p.danger}33` : p.line,
      overflow: 'hidden',
      opacity: done ? 0.7 : 1,
    }}>
      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={() => onOpen(task)}
        {...drag.handlers}
        android_ripple={{ color: p.accentSoft }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingLeft: 12,
          paddingRight: 8,
          paddingVertical: 9,
          opacity: pressed && !drag.active ? 0.9 : 1,
        })}
      >
        <Tick colour={colour} done={done} size={20} label={task.title} onPress={() => onToggle(node.row, occKey, null)} />

        <View style={{ flex: 1, gap: 5 }}>
          <Row gap={6} style={{ alignItems: 'center' }}>
            <Text
              variant="body"
              tone={done ? 'faint' : 'ink'}
              numberOfLines={2}
              // `flex: 1`, never `flexShrink`. See the note in `Today.tsx`.
              style={{
                flex: 1, textAlign: 'left', fontSize: 14, lineHeight: 19,
                textDecorationLine: done ? 'line-through' : 'none',
              }}
            >
              {task.title || 'Untitled'}
            </Text>
            {children.length > 0 ? (
              <View style={{ paddingHorizontal: 6, borderRadius: 9, borderWidth: 1, borderColor: p.line }}>
                <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>{doneKids}/{children.length}</Text>
              </View>
            ) : null}
          </Row>

          {pills ? (
            <Row gap={6} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
              {list ? (
                <Pill>
                  <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: list.color || p.ok }} />
                  <Text variant="caption" tone="soft" style={{ fontSize: 11 }}>{list.name}</Text>
                </Pill>
              ) : null}
              {showDate && due ? (
                <Pill colour={overdue ? p.danger : undefined}>
                  <Image
                    source={{ uri: ICONS[overdue ? 'triangle-alert' : 'calendar'] }}
                    style={{ width: 11, height: 11, tintColor: overdue ? p.danger : p.inkSoft }}
                  />
                  <Text variant="caption" style={{ fontSize: 11, color: overdue ? p.danger : p.inkSoft }}>{shortDate(due)}</Text>
                </Pill>
              ) : null}
              {startMin !== null ? (
                <Pill>
                  <Image source={{ uri: ICONS.clock }} style={{ width: 11, height: 11, tintColor: p.inkSoft }} />
                  <Text variant="caption" tone="soft" style={{ fontSize: 11 }}>{formatClock(startMin, clock)}</Text>
                </Pill>
              ) : null}
              {task.recur ? (
                <Image source={{ uri: ICONS.repeat }} style={{ width: 12, height: 12, tintColor: p.inkFaint }} accessibilityLabel="Repeats" />
              ) : null}
              {hasNotes ? (
                <Image source={{ uri: ICONS['align-left'] }} style={{ width: 12, height: 12, tintColor: p.inkFaint }} accessibilityLabel="Has notes" />
              ) : null}
            </Row>
          ) : null}
        </View>

        <Pressable
          unstable_pressDelay={PRESS_DELAY}
          onPress={() => onCompose(!composing)}
          accessibilityRole="button"
          accessibilityLabel={`Add a step to ${task.title || 'this task'}`}
          hitSlop={space.sm}
          style={({ pressed }) => ({
            width: 28, height: 28, borderRadius: 14,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1,
            borderColor: composing ? p.accent : p.line,
            backgroundColor: composing || pressed ? p.accentSoft : 'transparent',
          })}
        >
          <Image source={{ uri: ICONS.plus }} style={{ width: 14, height: 14, tintColor: composing ? p.accent : p.inkFaint }} />
        </Pressable>
      </Pressable>

      {children.length > 0 || composing ? (
        <View style={{ borderTopWidth: 1, borderTopColor: p.line }}>
          <SortableList
            data={children}
            keyExtractor={child => child.occId}
            onReorder={onMoveChild}
            renderItem={(child, _i, childDrag) => (
              <SubtaskRow
                row={child}
                today={today}
                parentDue={due}
                drag={childDrag}
                pending={pending(child.occId)}
                onToggle={() => onToggle(child, child.occId, task)}
                onOpen={() => onOpen(child.task)}
              />
            )}
          />

          {composing ? (
            <Composer
              onSubmit={onAddSubtask}
              onClose={() => onCompose(false)}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** A small outlined pill under a task's title, as on the PC. */
function Pill({ colour, children }: { colour?: string; children: React.ReactNode }) {
  const p = useTheme();
  return (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 4,
      height: 20, paddingHorizontal: 7, borderRadius: 10,
      borderWidth: 1, borderColor: colour ? `${colour}55` : p.line,
    }}>
      {children}
    </View>
  );
}

function SubtaskRow({
  row, today, parentDue, drag, pending,
  onToggle, onOpen,
}: {
  row: BoardRow;
  today: string;
  parentDue: string | null;
  drag: DragHandle;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const p = useTheme();
  const task = row.task;
  // Under a repeat this is the PARENT'S day, and the step is done for that day
  // alone. Reading the step's own date instead is what used to tie a step off
  // for every future occurrence the moment it was ticked once.
  const due = row.due;
  const done = row.done || pending;
  // A step is almost always due with its parent, and repeating the parent's own
  // date under every one of its steps is a column of the same word. So the date
  // appears only when it says something new: this step is late, or it is not on
  // the day the card above it claims.
  const late = !done && due !== null && due < today;
  const showDue = due !== null && (late || due !== parentDue);

  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={() => onOpen()}
      {...drag.handlers}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingLeft: 40,
        paddingRight: space.md,
        paddingVertical: space.sm,
        opacity: pressed && !drag.active ? 0.9 : done ? 0.55 : 1,
      })}
    >
      <Tick
        colour={p.inkFaint}
        done={done}
        size={18}
        label={task.title}
        onPress={onToggle}
      />

      <View style={{ flex: 1 }}>
        <Text variant="body" tone={done ? 'faint' : 'soft'} numberOfLines={2}>
          {task.title || 'Untitled'}
        </Text>
        {showDue ? (
          <Text
            variant="caption"
            style={{ marginTop: 2, fontSize: 12, color: late ? p.danger : p.inkFaint }}
          >
            {describeDue(due as string, today)}
          </Text>
        ) : null}
      </View>

    </Pressable>
  );
}




/**
 * The line that adds a step.
 *
 * It stays open after each one, because steps arrive in threes and fours and
 * reopening the same control between them is the whole cost of the feature.
 */
function Composer({ onSubmit, onClose }: {
  onSubmit: (title: string) => Promise<void>;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    try {
      await onSubmit(trimmed);
      setText('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Row
      gap={space.sm}
      style={{ paddingLeft: 40, paddingRight: space.md, paddingVertical: space.sm }}
    >
      <View style={{ flex: 1 }}>
        <TextField
          value={text}
          onChange={setText}
          placeholder="Add a step"
          autoFocus
        />
      </View>
      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={() => (text.trim() ? void add() : onClose())}
        accessibilityRole="button"
        accessibilityLabel={text.trim() ? 'Add this step' : 'Close'}
        hitSlop={space.sm}
        style={({ pressed }) => [{ paddingHorizontal: space.sm, height: 44, justifyContent: 'center' }, pressed ? PRESSED : null]}
      >
        <Text variant="bodyStrong" tone={text.trim() ? 'accent' : 'faint'}>
          {text.trim() ? 'Add' : 'Close'}
        </Text>
      </Pressable>
    </Row>
  );
}

/** "Today", "Yesterday", "Tue 2 Sep" — a date a person can read at a glance. */
function describeDue(due: string, today: string): string {
  if (due === today) return 'Today';

  const d = new Date(`${due}T00:00:00`);
  const t = new Date(`${today}T00:00:00`);
  const days = Math.round((d.getTime() - t.getTime()) / 86_400_000);

  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  if (days < 0) return `${Math.abs(days)} days ago`;
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
