// ─── Tasks ───────────────────────────────────────────────────────────────────
// A place of their own, rather than whatever was left at the bottom of a day.
//
// WHY BUCKETS AND NOT A LIST
// "What do I still have to do" is a question about lateness, not about dates. A
// flat list sorted by due date buries the two things that matter — what is
// already late, and what is due now — under everything that is merely coming.
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

import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Text, useTheme } from '../ui/kit';
import { radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import { Editor, type EditorTarget } from './Editor';
import { dueDateOf, isTaskDone, taskBucket, todayYmd, type Task } from '../lib/tasks';
import { formatClock } from '../lib/agenda';
import { fromTimeString } from '../lib/draft';

type Bucket = 'overdue' | 'today' | 'upcoming' | 'general';

const ORDER: { key: Bucket | 'done'; title: string; tone: 'danger' | 'accent' | 'ink' | 'faint' }[] = [
  { key: 'overdue', title: 'Overdue', tone: 'danger' },
  { key: 'today', title: 'Today', tone: 'accent' },
  { key: 'upcoming', title: 'Upcoming', tone: 'ink' },
  { key: 'general', title: 'Anytime', tone: 'faint' },
  { key: 'done', title: 'Done', tone: 'faint' },
];

export function Tasks() {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { tasks, syncNow, edit, timeFormat, taskLists } = usePlanner();

  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [showDone, setShowDone] = useState(false);

  const today = todayYmd();

  const grouped = useMemo(() => {
    const all = Object.values(tasks() as Record<string, unknown>) as Task[];
    const out: Record<string, Task[]> = {
      overdue: [], today: [], upcoming: [], general: [], done: [],
    };

    for (const t of all) {
      if (!t || typeof t !== 'object') continue;
      if ((t as any).deleted === true) continue;
      const due = dueDateOf(t);
      if (isTaskDone(t, due)) out.done.push(t);
      else out[taskBucket(t, due, today)].push(t);
    }

    // Dated buckets read best in date order; undated ones by name, since there
    // is nothing else to go on and alphabetical is at least predictable.
    for (const key of ['overdue', 'today', 'upcoming'] as const) {
      out[key].sort((a, b) => (dueDateOf(a) ?? '').localeCompare(dueDateOf(b) ?? '')
        || (a.title ?? '').localeCompare(b.title ?? ''));
    }
    out.general.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? ''));
    // Most recently finished first — the useful order for "did I do that?".
    out.done.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
    return out;
  }, [tasks, today]);

  const open = grouped.overdue.length + grouped.today.length
    + grouped.upcoming.length + grouped.general.length;

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

  const listName = (id: string | undefined): string | undefined => {
    if (!id) return undefined;
    const found = (taskLists as any[]).find(l => l?.id === id);
    return found?.name;
  };

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Text variant="caption" tone="faint">
          {open === 0 ? 'NOTHING OUTSTANDING' : `${open} TO DO`}
        </Text>
        <Text variant="display">Tasks</Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.accent} />
        }
      >
        {open === 0 && grouped.done.length === 0 ? (
          <View style={{ paddingTop: space.xxl, alignItems: 'center', gap: space.sm }}>
            <Text variant="heading" tone="soft">No tasks yet</Text>
            <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 260 }}>
              Add one with the button below, or on your PC — they meet in the middle.
            </Text>
          </View>
        ) : null}

        {ORDER.map(section => {
          const items = grouped[section.key];
          if (!items || items.length === 0) return null;

          const collapsible = section.key === 'done';
          const visible = collapsible && !showDone ? [] : items;

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
                    {collapsible ? `${items.length} ${showDone ? '▾' : '▸'}` : items.length}
                  </Text>
                </Row>
              </Pressable>

              <View style={{ gap: space.sm, marginTop: space.sm }}>
                {visible.map(t => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    today={today}
                    clock={timeFormat}
                    list={listName(t.listId)}
                    onToggle={() => toggle(t)}
                    onOpen={() => setEditing({
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
        onPress={() => setEditing({ store: 'tasks', date: today })}
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

function TaskRow({ task, today, clock, list, onToggle, onOpen }: {
  task: Task;
  today: string;
  clock?: string;
  list?: string;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const p = useTheme();
  const due = dueDateOf(task);
  const done = isTaskDone(task, due);
  const colour = task.color ?? p.ok;
  const startMin = task.startTime ? fromTimeString(task.startTime) : null;

  return (
    <Pressable
      onPress={onOpen}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        padding: space.md,
        borderRadius: radius.md,
        backgroundColor: p.surface,
        borderWidth: 1,
        borderColor: p.line,
        overflow: 'hidden',
        opacity: pressed ? 0.9 : done ? 0.6 : 1,
      })}
    >
      <View style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colour,
      }} />

      <Pressable
        onPress={onToggle}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: done }}
        accessibilityLabel={task.title}
        hitSlop={space.md}
        style={{
          width: 22, height: 22, borderRadius: 11,
          borderWidth: 2,
          borderColor: done ? colour : p.inkFaint,
          backgroundColor: done ? colour : 'transparent',
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {done ? (
          <Text style={{ color: p.accentInk, fontSize: 13, lineHeight: 15, fontWeight: '900' }}>✓</Text>
        ) : null}
      </Pressable>

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

        {(due || list || startMin !== null) ? (
          <Row gap={space.sm} style={{ marginTop: 3, alignItems: 'center', flexWrap: 'wrap' }}>
            {due ? (
              <Text
                variant="caption"
                style={{ color: !done && due < today ? p.danger : p.inkFaint, fontSize: 12 }}
              >
                {describeDue(due, today)}
                {startMin !== null ? ` · ${formatClock(startMin, clock)}` : ''}
              </Text>
            ) : startMin !== null ? (
              <Text variant="caption" tone="faint" style={{ fontSize: 12 }}>
                {formatClock(startMin, clock)}
              </Text>
            ) : null}
            {list ? (
              <Text variant="caption" tone="faint" style={{ fontSize: 12 }}>· {list}</Text>
            ) : null}
          </Row>
        ) : null}
      </View>
    </Pressable>
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
