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
//   UPCOMING   has a date, later.
//   ANYTIME    no date at all. Not late, not urgent, not lost either.
//   DONE       folded away, because finished work should be findable but quiet.
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
import { Pressable, RefreshControl, ScrollView, View, Alert } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Text, useTheme } from '../ui/kit';
import { TextField } from '../ui/Fields';
import { ListChips } from '../ui/ListChips';
import { SortableList, SortableScrollView, type DragHandle } from '../ui/SortableList';
import { Tick } from '../ui/Tick';
import { PRESSED, PRESS_DELAY, radius, space } from '../theme';
import { prefs } from '../lib/prefs';
import { usePlanner } from '../state/planner';
import { Editor, type EditorTarget } from './Editor';
import { dueDateOf, isTaskDone, taskBucket, todayYmd, type Task } from '../lib/tasks';
import { GENERAL_LIST_ID, resolveListId, type TaskList } from '../lib/taskLists';
import { buildTaskRows, groupTasks, DEFAULT_SORT_MODE, type SortMode } from '../lib/taskBoard';
import { manualOrders, reorderList } from '../lib/dragSort';
import { planTick, setPending, isPending as heldDone } from '../lib/pendingDone';
import type { TaskFilter } from '../lib/tasks';

import { formatClock } from '../lib/agenda';
import { fromTimeString } from '../lib/draft';

/** How long a ticked row stays where it is, so the tick can be seen. */
const DONE_HOLD_MS = 420;

type Bucket = 'overdue' | 'today' | 'upcoming' | 'general';
type SectionKey = Bucket | 'done';

/** One root task with the steps drawn underneath it. */
interface Node {
  task: Task;
  children: Task[];
}

const ORDER: { key: string; title: string; tone: 'danger' | 'accent' | 'ink' | 'faint' }[] = [
  { key: 'Overdue', title: 'Overdue', tone: 'danger' },
  { key: 'Today', title: 'Today', tone: 'accent' },
  { key: 'Tomorrow', title: 'Tomorrow', tone: 'ink' },
  { key: 'Upcoming', title: 'Upcoming', tone: 'ink' },
  { key: 'General', title: 'Anytime', tone: 'faint' },
  { key: 'Done', title: 'Done', tone: 'faint' },
];

/**
 * A task nobody has placed by hand sorts AFTER the ones somebody has.
 *
 * The alternative, treating an absent `order` as zero, would drop every task the
 * user has never touched on top of the arrangement they just made, which is the
 * one thing a manual order exists to prevent. When nothing in a group has an
 * order they all tie here and the date rule decides, which is why the screen is
 * unchanged until the first move.
 */
const orderKey = (t: Task): number =>
  (typeof t.order === 'number' && Number.isFinite(t.order) ? t.order : Number.MAX_SAFE_INTEGER);

const byHand = (a: Task, b: Task): number => orderKey(a) - orderKey(b);

export function Tasks() {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { tasks, syncNow, edit, saveDraft, removeItem, timeFormat, taskLists } = usePlanner();

  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [listFilter, setListFilter] = useState<string | null>(null);
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
  const setSortMode = (mode: SortMode) => {
    sortTouched.current = true;
    setSortModeState(mode);
    void prefs.setTaskSort(mode);
  };
  const [filters, setFilters] = useState<TaskFilter[]>([]);

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


  const today = todayYmd();

  const lists = useMemo<TaskList[]>(() => (
    (taskLists as any[])
      .filter(l => l && typeof l === 'object' && typeof l.id === 'string')
      .map(l => ({ id: l.id, name: String(l.name ?? 'Untitled'), color: String(l.color ?? '') }))
  ), [taskLists]);

  // Lists are created and deleted on the PC, so the chip that is selected here
  // can disappear underneath the user. Falling back to "All" keeps a deleted
  // list from hiding every task behind a filter nothing can clear.
  const filter = listFilter && lists.some(l => l.id === listFilter) ? listFilter : null;

  // Only worth a strip when there is a choice to make: a planner with nothing
  // but General has one possible answer, and a filter with one option is noise.
  const showChips = lists.filter(l => l.id !== GENERAL_LIST_ID).length > 0;

  
  const grouped = useMemo(() => {
    const rawTasks = tasks() as unknown as Record<string, Task>;
    const rows = buildTaskRows(rawTasks, today, true);
    return groupTasks(rows, rawTasks, lists, filter, filters, today, sortMode);
  }, [tasks, today, filter, lists, filters, sortMode]);


  
  const openNodes = grouped.Overdue.length + grouped.Today.length + grouped.Tomorrow.length + grouped.Upcoming.length + grouped.General.length;

  const open = useMemo(() => {
    let n = 0;
    for (const key of ['Overdue', 'Today', 'Tomorrow', 'Upcoming', 'General'] as const) {
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

  /** What the tick box is actually wired to. `toggle` below does the writing. */
  const toggleAnimated = (key: string, t: Task, occDate?: string | null) => {
    const due = occDate !== undefined ? (occDate ?? null) : dueDateOf(t);
    const stored = isTaskDone(t, due);
    const plan = planTick(stored, isPending(key));

    // 'write' is an un-tick, which is never held. 'cancel' is a second tap
    // inside the hold: forget it, and nothing is ever written.
    if (plan !== 'hold') {
      clearPending(key);
      if (plan === 'write') toggle(t, occDate);
      return;
    }

    setPendingDone(prev => setPending(prev, key, true));
    const existing = doneTimers.current[key];
    if (existing) clearTimeout(existing);

    const write = () => {
      delete doneTimers.current[key];
      delete doneWrites.current[key];
      toggle(t, occDate);
      // Same tick as the write, which commits synchronously, so the row never
      // flickers back to undone between the two.
      setPendingDone(prev => setPending(prev, key, false));
    };

    doneWrites.current[key] = write;
    doneTimers.current[key] = setTimeout(write, DONE_HOLD_MS);
  };

  const toggle = (t: Task, occDate?: string | null) => {
    const due = occDate !== undefined ? (occDate ?? null) : dueDateOf(t);
    const done = isTaskDone(t, due);
    const dates: string[] = Array.isArray(t.completedDates) ? [...t.completedDates] : [];

    if (t.recur && due) {
      // A repeat is ticked for THIS occurrence, never as a whole.
      void edit('tasks', t.id, {
        completedDates: done ? dates.filter(d => d !== due) : [...new Set([...dates, due])],
      });
      return;
    }
    void edit('tasks', t.id, {
      completed: !done,
      completedAt: done ? undefined : Date.now(),
      // Kept in step with the flag so whichever the PC happens to read agrees.
      completedDates: due
        ? (done ? dates.filter(d => d !== due) : [...new Set([...dates, due])])
        : dates,
    });
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
  const moveItem = (group: Task[], fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    const next = reorderList(group, fromIndex, toIndex);
    const keys = manualOrders(next.length);
    next.forEach((t, i) => {
      if (t.order !== keys[i]) void edit('tasks', t.id, { order: keys[i] });
    });
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
      order: siblings.length,
      // Only written when there is one: filing a step on "no list" explicitly
      // would be an edit that says nothing, and the parent is what decides.
      ...(parent.listId ? { listId: parent.listId } : {}),
    });
  };

  /** The list a task is filed on, or null when it is on General. */
  const listOf = (t: Task): TaskList | null => {
    if (lists.length === 0) return null;
    const id = resolveListId(t.listId, lists);
    // General is the ABSENCE of a list, not a list. Printing its name on every
    // unfiled row would put a word on most of the screen that tells nobody
    // anything: a row with no marker is on General, by elimination.
    if (id === GENERAL_LIST_ID) return null;
    return lists.find(l => l.id === id) ?? null;
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
        gap: space.sm,
      }}>
        <View style={{ paddingHorizontal: space.xl }}>
          <Text variant="caption" tone="faint">
            {open === 0 ? 'NOTHING OUTSTANDING' : `${open} TO DO`}
          </Text>
          <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <Text variant="display">Tasks</Text>
          </Row>
        </View>

        
        {showChips ? (
          <ListChips
            options={lists}
            value={filter}
            onChange={setListFilter}
            allLabel="All"
            inset={space.xl}
          />
        ) : null}

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: space.xl, paddingVertical: space.sm, gap: space.sm }}>
          {['datetime', 'manual', 'title'].map((mode) => (
            <Pressable
        unstable_pressDelay={PRESS_DELAY}
              key={mode}
              onPress={() => setSortMode(mode as SortMode)}
              style={({ pressed }) => [{
                paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: 16,
                backgroundColor: sortMode === mode ? p.accentSoft : p.surfaceAlt,
                borderWidth: 1, borderColor: sortMode === mode ? p.accent : p.line
              }, pressed ? PRESSED : null]}
            >
              <Text variant="caption" tone={sortMode === mode ? 'accent' : 'faint'}>
                {mode === 'datetime' ? 'Date' : mode === 'manual' ? 'Manual' : 'Title'}
              </Text>
            </Pressable>
          ))}
          <View style={{ width: 1, backgroundColor: p.line, marginVertical: 4 }} />
          {(['today', 'overdue', 'upcoming', 'general', 'completed'] as TaskFilter[]).map((f) => {
            const labels = { today: 'Today', overdue: 'Overdue', upcoming: 'Upcoming', general: 'General', completed: 'Done' };
            const active = filters.includes(f);
            return (
              <Pressable
        unstable_pressDelay={PRESS_DELAY}
                key={f}
                onPress={() => setFilters(active ? filters.filter(x => x !== f) : [...filters, f])}
                style={({ pressed }) => [{
                  paddingHorizontal: space.md, paddingVertical: space.xs, borderRadius: 16,
                  backgroundColor: active ? p.accentSoft : 'transparent',
                  borderWidth: 1, borderColor: active ? p.accent : p.line
                }, pressed ? PRESSED : null]}
              >
                <Text variant="caption" tone={active ? 'accent' : 'faint'}>
                  {labels[f as keyof typeof labels]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

      </View>



      <SortableScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + 120,
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
                : 'Add one with the button below, or on your PC. They meet in the middle.'}
            </Text>
          </View>
        ) : null}

        
        {ORDER.map(section => {
          const nodes = grouped[section.key as keyof typeof grouped] ?? [];
          if (!nodes || nodes.length === 0) return null;

          const collapsible = section.key === 'Done';
          const visible = collapsible && !showDone ? [] : nodes;

          return (
            <View key={section.key} style={{ marginBottom: space.xl }}>
              <Pressable
        unstable_pressDelay={PRESS_DELAY}
                onPress={collapsible ? () => setShowDone(v => !v) : undefined}
                disabled={!collapsible}
                style={({ pressed }) => [{ paddingVertical: space.xs }, pressed ? PRESSED : null]}
              >
                <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
                  <Text
                    variant="label"
                    style={{
                      letterSpacing: 1,
                      color: section.tone === 'danger' ? p.danger
                        : section.tone === 'accent' ? p.accent
                          : section.tone === 'ink' ? p.ink : p.inkFaint,
                    }}
                  >
                    {section.title.toUpperCase()}
                  </Text>
                  <Row gap={space.md} style={{ alignItems: 'center' }}>
                    {collapsible && nodes.length > 0 && (
                      <Pressable
        unstable_pressDelay={PRESS_DELAY}
      style={({ pressed }) => (pressed ? PRESSED : null)} 
                        onPress={(e) => { 
                          e.stopPropagation();
// A REPEATING task is never cleared here. Its row carries the
                          // master's id, so deleting it would take the whole
                          // series with it: one tap on "Clear" and every future
                          // Tuesday is gone. Ticking one occurrence of a repeat
                          // is not something there is anything to clean up from,
                          // so those rows are simply left alone.
                          const clearable = nodes.filter(n => !n.row.task.recur);
                          if (clearable.length === 0) {
                            Alert.alert(
                              'Nothing to clear',
                              'These are all repeating tasks, so there is nothing here to delete.',
                            );
                            return;
                          }
                          const kept = nodes.length - clearable.length;
                          Alert.alert(
                            'Clear completed?',
                            kept > 0
                              ? `This deletes ${clearable.length} finished ${clearable.length === 1 ? 'task' : 'tasks'}. ${kept} repeating ${kept === 1 ? 'one stays' : 'ones stay'}.`
                              : `This deletes ${clearable.length} finished ${clearable.length === 1 ? 'task' : 'tasks'} for good.`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              { text: 'Clear', style: 'destructive', onPress: () => {
                                // A tombstone through `removeItem`, not a local
                                // field: dropping the record here would leave the
                                // PC holding it and the next sync would hand it
                                // straight back.
                                clearable.forEach(n => { void removeItem('tasks', n.row.task.id); });
                              }},
                            ],
                          );
                        }}
                        hitSlop={space.sm}
                      >
                        <Text variant="caption" tone="accent">Clear</Text>
                      </Pressable>
                    )}
                    <Text variant="caption" tone="faint">
                      {collapsible ? `${nodes.length} ${showDone ? '▾' : '▸'}` : nodes.length}
                    </Text>
                  </Row>
                </Row>
              </Pressable>

              <View style={{ gap: space.sm, marginTop: space.sm }}>
                <SortableList
                  data={visible}
                  keyExtractor={n => n.row.occId}
                  onReorder={(fromIdx, toIdx) => moveItem(visible.map(n => n.row.task), fromIdx, toIdx)}
                  renderItem={(node, _index, drag) => (
                    <TaskCard
                      node={{ task: node.row.task, children: node.children.map(c => c.task) }}
                      today={today}
                      clock={timeFormat}
                      list={filter ? null : listOf(node.row.task)}
                      drag={drag}
                      occKey={node.row.occId}
                      pending={isPending}
                      composing={composingFor === node.row.task.id}
                      onCompose={next => setComposingFor(next ? node.row.task.id : null)}
                      onAddSubtask={title => addSubtask(node.row.task, title, node.children.map(c => c.task))}
                      onMoveChild={(fromChild, toChild) => moveItem(node.children.map(c => c.task), fromChild, toChild)}
                      onToggle={(t, key) => toggleAnimated(key, t, t.id === node.row.task.id ? node.row.due : undefined)}
                      onOpen={t => setEditing({
                        store: 'tasks', id: t.id, date: t.id === node.row.task.id ? (node.row.due ?? today) : (dueDateOf(t) ?? today),
                      })}
                    />
                  )}
                />
              </View>
            </View>
          );
        })}
      </SortableScrollView>

      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={() => setEditing({ store: 'tasks', date: today, listId: filter ?? undefined })}
        accessibilityRole="button"
        accessibilityLabel="Add a task"
        android_ripple={{ color: p.accentSoft, radius: 34 }}
        style={({ pressed }) => ({
          position: 'absolute',
          right: space.xl,
          bottom: insets.bottom + space.xl,
          width: 60, height: 60, borderRadius: 30,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: p.accent,
          transform: [{ scale: pressed ? 0.94 : 1 }],
          elevation: 8,
          shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 12,
          shadowOffset: { width: 0, height: 5 },
        })}
      >
        <Text variant="display" style={{ color: p.accentInk, fontSize: 32, lineHeight: 36 }}>+</Text>
      </Pressable>

      <Editor target={editing} onClose={() => setEditing(null)} />
    </View>
  );
}

// ─── One task, and its steps ─────────────────────────────────────────────────
// The card is the unit, not the row: a task and everything under it share one
// surface, one edge stripe and one border, so a glance separates "three things
// to do" from "one thing in three parts" without reading a word.

function TaskCard({
  node, today, clock, list, drag, composing, occKey, pending,
  onMoveChild, onToggle, onOpen, onCompose, onAddSubtask,
}: {
  node: Node;
  today: string;
  clock?: string;
  list: TaskList | null;
  drag: DragHandle;
  composing: boolean;
  /** What this row is keyed by while it waits to be written. */
  occKey: string;
  pending: (key: string) => boolean;
  onMoveChild: (fromIndex: number, toIndex: number) => void;
  onToggle: (t: Task, key: string) => void;
  onOpen: (t: Task) => void;
  onCompose: (open: boolean) => void;
  onAddSubtask: (title: string) => Promise<void>;
}) {
  const p = useTheme();
  const { task, children } = node;
  const due = dueDateOf(task);
  // Optimistic on purpose: everything below reads "done" from what the user has
  // just done, not from what has been stored yet.
  const done = isTaskDone(task, due) || pending(occKey);
  // An explicit colour on the task wins; otherwise the list it is filed on says
  // more at a glance than a default green does.
  const colour = task.color ?? list?.color ?? p.ok;
  const startMin = task.startTime ? fromTimeString(task.startTime) : null;
  const doneKids = children.filter(c => isTaskDone(c, dueDateOf(c)) || pending(c.id)).length;

  const meta: string[] = [];
  if (due) {
    meta.push(describeDue(due, today) + (startMin !== null ? ` ${formatClock(startMin, clock)}` : ''));
  } else if (startMin !== null) {
    meta.push(formatClock(startMin, clock));
  }
  if (list) meta.push(list.name);
  if (children.length > 0) meta.push(`${doneKids} of ${children.length} done`);

  return (
    <View style={{
      borderRadius: radius.md,
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.line,
      overflow: 'hidden',
      opacity: done ? 0.6 : 1,
    }}>
      <View style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colour,
      }} />

      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={() => onOpen(task)}
        {...drag.handlers}
        android_ripple={{ color: p.accentSoft }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          padding: space.md,
          opacity: pressed && !drag.active ? 0.9 : 1,
        })}
      >
        <Tick colour={colour} done={done} label={task.title} onPress={() => onToggle(task, occKey)} />

        <View style={{ flex: 1 }}>
          <Row gap={space.xs} style={{ alignItems: 'center' }}>
            <Text
              variant="bodyStrong"
              tone={done ? 'faint' : 'ink'}
              numberOfLines={2}
              // `flex: 1`, never `flexShrink`. See the note in `Today.tsx`.
              style={{ flex: 1, textAlign: 'left' }}
            >
              {task.title || 'Untitled'}
            </Text>
            {task.recur ? <Text variant="caption" tone="faint" style={{ fontSize: 13 }}>↻</Text> : null}
          </Row>

          {meta.length > 0 ? (
            <Text
              variant="caption"
              numberOfLines={1}
              style={{
                marginTop: 3,
                fontSize: 12,
                color: !done && due && due < today ? p.danger : p.inkFaint,
              }}
            >
              {meta.join(' · ')}
            </Text>
          ) : null}
        </View>

        <Pressable
        unstable_pressDelay={PRESS_DELAY}
          onPress={() => onCompose(!composing)}
          accessibilityRole="button"
          accessibilityLabel={`Add a step to ${task.title || 'this task'}`}
          hitSlop={space.sm}
          style={({ pressed }) => ({
            width: 34, height: 34, borderRadius: 17,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 1,
            borderColor: composing ? p.accent : p.line,
            backgroundColor: composing || pressed ? p.accentSoft : 'transparent',
          })}
        >
          <Text
            variant="body"
            tone={composing ? 'accent' : 'faint'}
            style={{ fontSize: 18, lineHeight: 20 }}
          >
            +
          </Text>
        </Pressable>
      </Pressable>

      {children.length > 0 || composing ? (
        <View style={{ borderTopWidth: 1, borderTopColor: p.line }}>
          <SortableList
            data={children}
            keyExtractor={child => child.id}
            onReorder={onMoveChild}
            renderItem={(child, _i, childDrag) => (
              <SubtaskRow
                task={child}
                today={today}
                parentDue={due}
                drag={childDrag}
                pending={pending(child.id)}
                onToggle={() => onToggle(child, child.id)}
                onOpen={() => onOpen(child)}
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

function SubtaskRow({
  task, today, parentDue, drag, pending,
  onToggle, onOpen,
}: {
  task: Task;
  today: string;
  parentDue: string | null;
  drag: DragHandle;
  pending: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const p = useTheme();
  const due = dueDateOf(task);
  const done = isTaskDone(task, due) || pending;
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
