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

import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Text, useTheme } from '../ui/kit';
import { TextField } from '../ui/Fields';
import { ListChips } from '../ui/ListChips';
import { radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import { Editor, type EditorTarget } from './Editor';
import { dueDateOf, isTaskDone, taskBucket, todayYmd, type Task } from '../lib/tasks';
import { GENERAL_LIST_ID, resolveListId, type TaskList } from '../lib/taskLists';
import { formatClock } from '../lib/agenda';
import { fromTimeString } from '../lib/draft';

type Bucket = 'overdue' | 'today' | 'upcoming' | 'general';
type SectionKey = Bucket | 'done';

/** One root task with the steps drawn underneath it. */
interface Node {
  task: Task;
  children: Task[];
}

const ORDER: { key: SectionKey; title: string; tone: 'danger' | 'accent' | 'ink' | 'faint' }[] = [
  { key: 'overdue', title: 'Overdue', tone: 'danger' },
  { key: 'today', title: 'Today', tone: 'accent' },
  { key: 'upcoming', title: 'Upcoming', tone: 'ink' },
  { key: 'general', title: 'Anytime', tone: 'faint' },
  { key: 'done', title: 'Done', tone: 'faint' },
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
  const { tasks, syncNow, edit, saveDraft, timeFormat, taskLists } = usePlanner();

  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [showDone, setShowDone] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [listFilter, setListFilter] = useState<string | null>(null);
  /** Which task, if any, has its "add a step" line open. */
  const [composingFor, setComposingFor] = useState<string | null>(null);

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
    const all = (Object.values(tasks() as Record<string, unknown>) as Task[])
      .filter(t => t && typeof t === 'object' && (t as any).deleted !== true);
    const byId = new Map(all.map(t => [t.id, t]));

    /**
     * The parent a task should be drawn under, or null if it is a root.
     *
     * ONE LEVEL, EVER. A step of a step is drawn as a task of its own rather
     * than indented twice: a third column of indentation does not fit a phone,
     * and the PC's model does not have one either. A subtask whose parent has
     * been deleted is promoted the same way, so nothing can become invisible by
     * losing the row it was hanging from.
     */
    const parentOf = (t: Task): Task | null => {
      if (!t.parentId || t.parentId === t.id) return null;
      const parent = byId.get(t.parentId);
      if (!parent || parent.parentId) return null;
      return parent;
    };

    const roots: Task[] = [];
    const kids = new Map<string, Task[]>();
    for (const t of all) {
      const parent = parentOf(t);
      if (!parent) { roots.push(t); continue; }
      const siblings = kids.get(parent.id);
      if (siblings) siblings.push(t); else kids.set(parent.id, [t]);
    }

    // The filter is applied to ROOTS only. A step belongs to its parent, not to
    // a list of its own, so filing a parent elsewhere takes its steps with it.
    const visible = filter
      ? roots.filter(t => resolveListId(t.listId, lists) === filter)
      : roots;

    const out: Record<SectionKey, Node[]> = {
      overdue: [], today: [], upcoming: [], general: [], done: [],
    };

    for (const t of visible) {
      const due = dueDateOf(t);
      const node: Node = {
        task: t,
        children: (kids.get(t.id) ?? []).sort((a, b) =>
          byHand(a, b) || (a.title ?? '').localeCompare(b.title ?? '')),
      };
      if (isTaskDone(t, due)) out.done.push(node);
      else out[taskBucket(t, due, today)].push(node);
    }

    // A hand-made order wins where there is one. Otherwise the dated buckets
    // read best in date order, and the undated one by name, since there is
    // nothing else to go on and alphabetical is at least predictable.
    for (const key of ['overdue', 'today', 'upcoming'] as const) {
      out[key].sort((a, b) => byHand(a.task, b.task)
        || (dueDateOf(a.task) ?? '').localeCompare(dueDateOf(b.task) ?? '')
        || (a.task.title ?? '').localeCompare(b.task.title ?? ''));
    }
    out.general.sort((a, b) => byHand(a.task, b.task)
      || (a.task.title ?? '').localeCompare(b.task.title ?? ''));
    // Most recently finished first, the useful order for "did I do that?".
    out.done.sort((a, b) => (b.task.completedAt ?? 0) - (a.task.completedAt ?? 0));
    return out;
  }, [tasks, today, filter, lists]);

  const openNodes = grouped.overdue.length + grouped.today.length
    + grouped.upcoming.length + grouped.general.length;

  // Steps count towards "still to do" as much as their parents: three unticked
  // boxes are three unticked boxes, whichever card they are drawn in.
  const open = useMemo(() => {
    let n = 0;
    for (const key of ['overdue', 'today', 'upcoming', 'general'] as const) {
      for (const node of grouped[key]) {
        n += 1;
        n += node.children.filter(c => !isTaskDone(c, dueDateOf(c))).length;
      }
    }
    return n;
  }, [grouped]);

  const nothingAtAll = openNodes === 0 && grouped.done.length === 0;

  const refresh = async () => {
    setRefreshing(true);
    try { await syncNow(); } finally { setRefreshing(false); }
  };

  const toggle = (t: Task) => {
    const due = dueDateOf(t);
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
   */
  const move = (group: Task[], index: number, dir: -1 | 1) => {
    const target = index + dir;
    if (target < 0 || target >= group.length) return;
    const next = [...group];
    next[index] = group[target];
    next[target] = group[index];
    next.forEach((t, i) => {
      if (t.order !== i) void edit('tasks', t.id, { order: i });
    });
  };

  /**
   * Add a step under a task.
   *
   * It inherits the parent's day rather than today's, so a step of something due
   * on Friday does not quietly appear in Today on the PC. A parent with no date
   * has nothing to inherit, and the step is filed on today instead, which is the
   * only date the phone's own editor can write.
   */
  const addSubtask = async (parent: Task, title: string, siblings: Task[]) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    const id = await saveDraft('tasks', {
      title: trimmed,
      date: dueDateOf(parent) ?? today,
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
            {openNodes > 0 || reordering ? (
              <Pressable
                onPress={() => { setReordering(v => !v); setComposingFor(null); }}
                accessibilityRole="button"
                accessibilityLabel={reordering ? 'Finish moving tasks' : 'Move tasks by hand'}
                hitSlop={space.md}
                style={{ paddingHorizontal: space.sm, paddingVertical: space.xs }}
              >
                <Text variant="bodyStrong" tone="accent">
                  {reordering ? 'Done' : 'Reorder'}
                </Text>
              </Pressable>
            ) : null}
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
      </View>

      {reordering ? (
        <View style={{
          paddingHorizontal: space.xl,
          paddingVertical: space.sm,
          backgroundColor: p.accentSoft,
        }}>
          <Text variant="caption" tone="accent">
            Use the arrows to move things within a group. Tap Done when it looks right.
          </Text>
        </View>
      ) : null}

      <ScrollView
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
          const nodes = grouped[section.key];
          if (!nodes || nodes.length === 0) return null;

          const collapsible = section.key === 'done';
          const visible = collapsible && !showDone ? [] : nodes;
          const movable = reordering && !collapsible;

          return (
            <View key={section.key} style={{ marginBottom: space.xl }}>
              <Pressable
                onPress={collapsible ? () => setShowDone(v => !v) : undefined}
                disabled={!collapsible}
                style={{ paddingVertical: space.xs }}
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
                  <Text variant="caption" tone="faint">
                    {collapsible ? `${nodes.length} ${showDone ? '▾' : '▸'}` : nodes.length}
                  </Text>
                </Row>
              </Pressable>

              <View style={{ gap: space.sm, marginTop: space.sm }}>
                {visible.map((node, index) => (
                  <TaskCard
                    key={node.task.id}
                    node={node}
                    today={today}
                    clock={timeFormat}
                    // Already filtered to one list: repeating its name on every
                    // row would say only what the chip above already says.
                    list={filter ? null : listOf(node.task)}
                    reordering={movable}
                    composing={composingFor === node.task.id}
                    onCompose={next => setComposingFor(next ? node.task.id : null)}
                    onAddSubtask={title => addSubtask(node.task, title, node.children)}
                    canMoveUp={index > 0}
                    canMoveDown={index < visible.length - 1}
                    onMove={dir => move(visible.map(n => n.task), index, dir)}
                    onMoveChild={(childIndex, dir) => move(node.children, childIndex, dir)}
                    onToggle={toggle}
                    onStartReorder={() => setReordering(true)}
                    onOpen={t => setEditing({
                      store: 'tasks', id: t.id, date: dueDateOf(t) ?? today,
                    })}
                  />
                ))}
              </View>
            </View>
          );
        })}
      </ScrollView>

      <Pressable
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
  node, today, clock, list, reordering, composing,
  canMoveUp, canMoveDown,
  onMove, onMoveChild, onToggle, onOpen, onCompose, onAddSubtask, onStartReorder,
}: {
  node: Node;
  today: string;
  clock?: string;
  list: TaskList | null;
  reordering: boolean;
  composing: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => void;
  onMoveChild: (index: number, dir: -1 | 1) => void;
  onToggle: (t: Task) => void;
  onOpen: (t: Task) => void;
  onCompose: (open: boolean) => void;
  onAddSubtask: (title: string) => Promise<void>;
  onStartReorder: () => void;
}) {
  const p = useTheme();
  const { task, children } = node;
  const due = dueDateOf(task);
  const done = isTaskDone(task, due);
  // An explicit colour on the task wins; otherwise the list it is filed on says
  // more at a glance than a default green does.
  const colour = task.color ?? list?.color ?? p.ok;
  const startMin = task.startTime ? fromTimeString(task.startTime) : null;
  const doneKids = children.filter(c => isTaskDone(c, dueDateOf(c))).length;

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
        onPress={() => (reordering ? undefined : onOpen(task))}
        onLongPress={reordering ? undefined : onStartReorder}
        delayLongPress={400}
        android_ripple={reordering ? undefined : { color: p.accentSoft }}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          padding: space.md,
          opacity: pressed && !reordering ? 0.9 : 1,
        })}
      >
        <Check colour={colour} done={done} label={task.title} onPress={() => onToggle(task)} />

        <View style={{ flex: 1 }}>
          <Row gap={space.xs} style={{ alignItems: 'center' }}>
            <Text
              variant="bodyStrong"
              tone={done ? 'faint' : 'ink'}
              numberOfLines={2}
              style={{ flexShrink: 1 }}
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

        {reordering ? (
          <Arrows
            up={canMoveUp}
            down={canMoveDown}
            label={task.title || 'this task'}
            onMove={onMove}
          />
        ) : (
          <Pressable
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
        )}
      </Pressable>

      {children.length > 0 || composing ? (
        <View style={{ borderTopWidth: 1, borderTopColor: p.line }}>
          {children.map((child, i) => (
            <SubtaskRow
              key={child.id}
              task={child}
              today={today}
              parentDue={due}
              reordering={reordering}
              canMoveUp={i > 0}
              canMoveDown={i < children.length - 1}
              onMove={dir => onMoveChild(i, dir)}
              onToggle={() => onToggle(child)}
              onOpen={() => onOpen(child)}
              onStartReorder={onStartReorder}
            />
          ))}

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
  task, today, parentDue, reordering, canMoveUp, canMoveDown,
  onMove, onToggle, onOpen, onStartReorder,
}: {
  task: Task;
  today: string;
  parentDue: string | null;
  reordering: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => void;
  onToggle: () => void;
  onOpen: () => void;
  onStartReorder: () => void;
}) {
  const p = useTheme();
  const due = dueDateOf(task);
  const done = isTaskDone(task, due);
  // A step is almost always due with its parent, and repeating the parent's own
  // date under every one of its steps is a column of the same word. So the date
  // appears only when it says something new: this step is late, or it is not on
  // the day the card above it claims.
  const late = !done && due !== null && due < today;
  const showDue = due !== null && (late || due !== parentDue);

  return (
    <Pressable
      onPress={() => (reordering ? undefined : onOpen())}
      onLongPress={reordering ? undefined : onStartReorder}
      delayLongPress={400}
      android_ripple={reordering ? undefined : { color: p.accentSoft }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingLeft: 40,
        paddingRight: space.md,
        paddingVertical: space.sm,
        opacity: pressed && !reordering ? 0.9 : done ? 0.55 : 1,
      })}
    >
      <Check
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

      {reordering ? (
        <Arrows
          up={canMoveUp}
          down={canMoveDown}
          label={task.title || 'this step'}
          onMove={onMove}
        />
      ) : null}
    </Pressable>
  );
}

/** The tick box. One shape at two sizes, so a step reads as a smaller sibling. */
function Check({ colour, done, onPress, label, size = 22 }: {
  colour: string;
  done: boolean;
  onPress: () => void;
  label?: string;
  size?: number;
}) {
  const p = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={label}
      hitSlop={space.md}
      style={{
        width: size, height: size, borderRadius: size / 2,
        borderWidth: 2,
        borderColor: done ? colour : p.inkFaint,
        backgroundColor: done ? colour : 'transparent',
        alignItems: 'center', justifyContent: 'center',
      }}
    >
      {done ? (
        <Text style={{
          color: p.accentInk, fontSize: size * 0.6, lineHeight: size * 0.7, fontWeight: '900',
        }}>
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}

/**
 * Up and down, as two buttons.
 *
 * Not a drag handle: dragging inside a scrolling list needs a gesture library,
 * and a native module would cost this app its over-the-air updates. Two arrows
 * are also the only control that works with a screen reader, and the one that
 * cannot drop something in the wrong place by accident.
 */
function Arrows({ up, down, label, onMove }: {
  up: boolean;
  down: boolean;
  label: string;
  onMove: (dir: -1 | 1) => void;
}) {
  const p = useTheme();

  const Arrow = ({ dir, on, glyph }: { dir: -1 | 1; on: boolean; glyph: string }) => (
    <Pressable
      onPress={() => onMove(dir)}
      disabled={!on}
      accessibilityRole="button"
      accessibilityLabel={`Move ${label} ${dir === -1 ? 'up' : 'down'}`}
      style={({ pressed }) => ({
        width: 38, height: 38,
        alignItems: 'center', justifyContent: 'center',
        borderRadius: radius.sm,
        backgroundColor: pressed ? p.accentSoft : p.surfaceAlt,
        borderWidth: 1,
        borderColor: p.line,
        opacity: on ? 1 : 0.3,
      })}
    >
      <Text variant="bodyStrong" tone="soft">{glyph}</Text>
    </Pressable>
  );

  return (
    <Row gap={space.xs}>
      <Arrow dir={-1} on={up} glyph="▲" />
      <Arrow dir={1} on={down} glyph="▼" />
    </Row>
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
        onPress={() => (text.trim() ? void add() : onClose())}
        accessibilityRole="button"
        accessibilityLabel={text.trim() ? 'Add this step' : 'Close'}
        hitSlop={space.sm}
        style={{ paddingHorizontal: space.sm, height: 44, justifyContent: 'center' }}
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
