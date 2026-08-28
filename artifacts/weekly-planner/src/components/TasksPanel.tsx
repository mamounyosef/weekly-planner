import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, MotionConfig } from 'framer-motion';
import {
  Check, ChevronDown, ChevronRight, Clock, ListTodo,
  MoreHorizontal, Plus, Repeat, StickyNote, X, Calendar, AlertCircle,
  Sparkles, ArrowRight, Sun, CalendarRange, Filter,
  ArrowUpDown, ArrowLeft, Layers, Pencil, Trash2, CornerDownRight,
} from 'lucide-react';
import { addDays, format } from 'date-fns';
import {
  formatRecurrenceLabel, parseDate,
  type DeleteMode, type RecurFreq, type Recurrence, type Weekday, type WeekStartsOn,
} from '@/lib/recurrence';
import type { TimeFormat } from '@/lib/settingsSync';
import {
  ALL_TASK_FILTERS, TASK_FILTER_LABELS, expandTaskRange, isTaskDone,
  taskBucket, todayYmd,
  type Task, type TaskData, type TaskFilter,
} from '@/lib/tasks';
import {
  GENERAL_LIST_ID, TASK_LIST_COLORS, makeListId, moveList, nextListColor, resolveListId,
  type TaskList as TaskListDef,
} from '@/lib/taskLists';
import { useReorder } from '@/lib/useReorder';
import { useViewport } from '@/hooks/use-mobile';

/** What the panel's composer hands back; home.tsx turns it into a real Task. */
export interface NewTaskInput {
  title: string;
  dueDate: string | null;   // 'yyyy-MM-dd', or null for a general task
  startTime?: string | null;
  listId?: string;
  recur?: Recurrence;
  notes?: string;
}

/** How a list's tasks are dealt with when the list itself is deleted. */
export type ListDeleteMode = 'keep' | 'purge';

export interface TaskChipColors { bg: string; border: string; text: string; textMuted: string }

export interface TaskTheme {
  darkMode: boolean;
  menuText: string;
  menuSub: string;
  menuBg: string;
  menuBdr: string;
  surfaceBg: string;
  surfaceBdr: string;
  hoverBg: string;
  accent: string;
  chip: (hex?: string) => TaskChipColors;
}

export type SortMode = 'datetime' | 'manual' | 'title' | 'title-desc';

const SORT_LABELS: Record<SortMode, string> = {
  datetime: 'Date & Time',
  manual: 'Manual Order',
  title: 'Title (A-Z)',
  'title-desc': 'Title (Z-A)',
};

interface TasksPanelProps {
  open: boolean;
  width: number;
  tasks: TaskData;
  filters: TaskFilter[];
  /** Optional explicit today date ('yyyy-MM-dd') from parent clock */
  today?: string;
  timeFormat: TimeFormat;
  weekStartsOn: WeekStartsOn;
  taskColor: string;
  taskCheckboxShape?: 'circle' | 'square';
  autoRollRecurringTasks?: boolean;
  theme: TaskTheme;
  /** Every list, in the order they appear on the rail. Always contains General. */
  lists: TaskListDef[];
  /** Which list the panel is showing; `null` is the "All lists" view. */
  activeListId: string | null;
  onActiveListChange: (id: string | null) => void;
  /** Create / rename / recolour / reorder — the whole array, already updated. */
  onListsChange: (next: TaskListDef[]) => void;
  onDeleteList: (id: string, mode: ListDeleteMode) => void;
  onMoveTaskToList: (occId: string, listId: string) => void;
  onFiltersChange: (f: TaskFilter[]) => void;
  onCreate: (input: NewTaskInput) => string | null;
  onToggleDone: (occId: string) => void;
  onEdit: (occId: string, patch: Partial<Task>) => string;
  onDelete: (occId: string, mode?: DeleteMode) => void;
  onOpenMenu: (occId: string, at: { x: number; y: number }) => void;
  onResize: (w: number) => void;
  onClose: () => void;
  /**
   * Phone mode. A 340px column docked beside the calendar is most of a phone
   * screen, so on a narrow layout the panel becomes a bottom sheet instead:
   * it slides up over the grid, dims what's behind it, and is dismissed by
   * swiping the grab handle back down.
   */
  sheet?: boolean;
  /**
   * Phone: render as a full screen of its own — the Tasks tab is a page beside
   * the calendar, not a layer on top of it. Implies `sheet`'s width behaviour
   * but drops the scrim, the slide-up and the grab handle.
   */
  page?: boolean;
  /** Optional content scale / zoom factor. */
  zoom?: number;
}

const COMPLETED_COLLAPSED_KEY = 'planner-tasks-completed-collapsed';
const SORT_MODE_KEY = 'planner-tasks-sort-mode';

/** One row in the flattened list: a task plus the occurrence date it represents. */
interface Row { occId: string; task: Task; due: string | null; done: boolean }
type InsertEdge = 'before' | 'after';

const fmtTime = (hhmm: string, timeFormat: TimeFormat): string => {
  if (!hhmm) return '';
  const [hStr, mStr] = hhmm.split(':');
  const h = Number(hStr);
  const m = Number(mStr);
  if (isNaN(h) || isNaN(m)) return hhmm;
  if (timeFormat === '24h') return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  const suffix = h >= 12 ? 'PM' : 'AM';
  const hour = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${hour} ${suffix}` : `${hour}:${String(m).padStart(2, '0')} ${suffix}`;
};

const TIME_PRESETS = ['09:00', '12:00', '15:00', '18:00'];

const LOOKBACK_DAYS = 28;
const LOOKAHEAD_DAYS = 365;

function useTaskRows(tasks: TaskData, today: string, autoRollRecurringTasks = true): Row[] {
  return useMemo(() => {
    const day = (n: number) => format(addDays(new Date(`${today}T00:00:00`), n), 'yyyy-MM-dd');
    const from = day(-LOOKBACK_DAYS);
    const to = day(LOOKAHEAD_DAYS);
    const staleBefore = day(-7);
    const rows: Row[] = [];

    for (const t of Object.values(tasks)) {
      if (t.deleted) continue;
      if (!t.weekKey) {
        rows.push({ occId: t.id, task: t, due: null, done: isTaskDone(t) });
        continue;
      }
      for (const { occId, occDate } of expandTaskRange(t, from, to, { autoRollRecurring: autoRollRecurringTasks, today })) {
        const done = isTaskDone(t, occDate);
        if (done && occDate < staleBefore) continue;
        rows.push({ occId, task: t.recur ? { ...t, occDate } : t, due: occDate, done });
      }
    }
    return rows;
  }, [tasks, today, autoRollRecurringTasks]);
}

function TasksPanel({
  open, width, tasks, filters, timeFormat, weekStartsOn, taskColor, taskCheckboxShape = 'circle',
  autoRollRecurringTasks = true, theme,
  today: propToday,
  lists, activeListId, onActiveListChange, onListsChange, onDeleteList, onMoveTaskToList,
  onFiltersChange, onCreate, onToggleDone, onEdit, onDelete, onOpenMenu, onResize, onClose,
  sheet = false,
  page = false,
  zoom,
}: TasksPanelProps) {
  const vp = useViewport();

  // Self-refreshing today date: updates on midnight rollover, periodic check, and tab focus / wake-up
  const [liveToday, setLiveToday] = useState<string>(() => propToday || todayYmd());

  useEffect(() => {
    if (propToday && propToday !== liveToday) {
      setLiveToday(propToday);
    }
  }, [propToday, liveToday]);

  useEffect(() => {
    const updateDay = () => {
      const current = propToday || todayYmd();
      setLiveToday(prev => (prev === current ? prev : current));
    };

    // 1. Regular 10-second check in case of drift, sleep resume, or system clock changes
    const intervalId = window.setInterval(updateDay, 10_000);

    // 2. Precise midnight schedule
    let midnightTimer: number | null = null;
    const scheduleMidnight = () => {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 50);
      const ms = Math.max(500, nextMidnight.getTime() - now.getTime());
      midnightTimer = window.setTimeout(() => {
        updateDay();
        scheduleMidnight();
      }, ms);
    };
    scheduleMidnight();

    // 3. Tab visibility & window focus triggers
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') updateDay();
    };
    window.addEventListener('focus', updateDay);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      if (midnightTimer !== null) window.clearTimeout(midnightTimer);
      window.removeEventListener('focus', updateDay);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [propToday]);

  const today = propToday || liveToday;
  const tomorrow = useMemo(() => format(addDays(new Date(`${today}T00:00:00`), 1), 'yyyy-MM-dd'), [today]);

  const allRows = useTaskRows(tasks, today, autoRollRecurringTasks);

  // ── Lists ──────────────────────────────────────────────────────────────────
  // A list is resolved, never trusted: a task pointing at a list that has since
  // been deleted (which can happen from the Settings window, where the task
  // store isn't reachable) reads as General rather than vanishing.
  const listsById = useMemo(() => {
    const m: Record<string, TaskListDef> = {};
    for (const l of lists) m[l.id] = l;
    return m;
  }, [lists]);

  const activeList = activeListId ? listsById[activeListId] ?? null : null;
  // An active list that was deleted elsewhere falls back to "All" rather than
  // leaving the panel stuck on a tab that no longer exists.
  const effectiveListId = activeListId && activeList ? activeListId : null;
  useEffect(() => {
    if (activeListId && !listsById[activeListId]) onActiveListChange(null);
  }, [activeListId, listsById, onActiveListChange]);

  /**
   * A subtask lives wherever its parent lives. Reading it off the parent rather
   * than copying the id onto every child means moving a task between lists
   * takes its subtasks with it, and a child can never be stranded on a list its
   * parent isn't on (where it would render as a rootless orphan).
   */
  const listOfTask = useCallback((t: Task): string => {
    const owner = (t.parentId ? tasks[t.parentId] : null) ?? t;
    return resolveListId(owner.listId, lists);
  }, [tasks, lists]);

  const rows = useMemo(
    () => (effectiveListId ? allRows.filter(r => listOfTask(r.task) === effectiveListId) : allRows),
    [allRows, effectiveListId, listOfTask],
  );

  /** Open (not done) task count per list id — what the rail's badges show. */
  const listCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of allRows) {
      if (r.done || r.task.parentId) continue;   // subtasks are counted through their parent
      const id = listOfTask(r.task);
      c[id] = (c[id] ?? 0) + 1;
    }
    return c;
  }, [allRows, listOfTask]);

  const [composerTitle, setComposerTitle] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerDate, setComposerDate] = useState<string | null>(today);
  const prevTodayRef = useRef(today);

  useEffect(() => {
    const prev = prevTodayRef.current;
    if (prev !== today) {
      // If composer date was sitting on previous today, advance to the new today automatically
      setComposerDate(current => (current === prev ? today : current));
      prevTodayRef.current = today;
    }
  }, [today]);

  const [composerTime, setComposerTime] = useState<string | null>(null);
  const [composerRecur, setComposerRecur] = useState<Recurrence | undefined>(undefined);
  const [composerNotes, setComposerNotes] = useState('');
  const [showTimePicker, setShowTimePicker] = useState(false);
  const [showRepeatPicker, setShowRepeatPicker] = useState(false);
  const [showNotesInput, setShowNotesInput] = useState(false);
  // Which list the composer files into. It follows the tab you're on, because
  // that's what "add a task here" means — but it stays overridable, so you can
  // sit on one list and throw something onto another without switching.
  const [composerListId, setComposerListId] = useState<string>(() => effectiveListId ?? GENERAL_LIST_ID);
  const [showListPicker, setShowListPicker] = useState(false);
  useEffect(() => {
    setComposerListId(effectiveListId ?? GENERAL_LIST_ID);
    setShowListPicker(false);
  }, [effectiveListId]);
  // The rail's inline editor: `null` closed, `'new'` creating, otherwise the id
  // of the list being edited.
  const [listEditor, setListEditor] = useState<string | null>(null);
  /** The list pill a task is currently being dragged over. */
  const [dragOverListId, setDragOverListId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedParents, setExpandedParents] = useState<Record<string, boolean>>({});

  const [sortMode, setSortMode] = useState<SortMode>(() => {
    try {
      const saved = localStorage.getItem(SORT_MODE_KEY);
      if (saved && (saved in SORT_LABELS)) return saved as SortMode;
    } catch { /* private mode */ }
    return 'datetime';
  });
  const [showSortMenu, setShowSortMenu] = useState(false);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [pendingDoneIds, setPendingDoneIds] = useState<Record<string, boolean>>({});

  const [completedCollapsed, setCompletedCollapsed] = useState(() => {
    try { return localStorage.getItem(COMPLETED_COLLAPSED_KEY) !== '0'; } catch { return true; }
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const doneTimersRef = useRef<Record<string, number>>({});

  useEffect(() => {
    try { localStorage.setItem(COMPLETED_COLLAPSED_KEY, completedCollapsed ? '1' : '0'); } catch { /* private mode */ }
  }, [completedCollapsed]);

  useEffect(() => {
    try { localStorage.setItem(SORT_MODE_KEY, sortMode); } catch { /* private mode */ }
  }, [sortMode]);

  useEffect(() => {
    return () => {
      Object.values(doneTimersRef.current).forEach(window.clearTimeout);
    };
  }, []);

  const resetComposer = useCallback(() => {
    setComposerTitle('');
    setComposerDate(today);
    setComposerTime(null);
    setComposerRecur(undefined);
    setComposerNotes('');
    setShowTimePicker(false);
    setShowRepeatPicker(false);
    setShowNotesInput(false);
  }, [today]);

  const submitComposer = useCallback(() => {
    const title = composerTitle.trim();
    if (!title) return;
    onCreate({
      title,
      dueDate: composerDate,
      startTime: composerDate ? composerTime : null,
      // General is the absence of a list, not a list id on every task: storing
      // it would mean every pre-lists task looked different from a new one.
      listId: composerListId === GENERAL_LIST_ID ? undefined : composerListId,
      recur: composerDate ? composerRecur : undefined,
      notes: composerNotes.trim() || undefined,
    });
    resetComposer();
    inputRef.current?.focus();
  }, [composerTitle, composerDate, composerTime, composerListId, composerRecur, composerNotes, onCreate, resetComposer]);

  // Filter counts
  const counts = useMemo(() => {
    const c: Record<TaskFilter, number> = { today: 0, overdue: 0, upcoming: 0, general: 0, completed: 0 };
    for (const r of rows) {
      if (r.done) { c.completed++; continue; }
      c[taskBucket(r.task, r.due, today)]++;
    }
    return c;
  }, [rows, today]);

  const toggleFilter = (f: TaskFilter) => {
    const next = filters.includes(f) ? filters.filter(x => x !== f) : [...filters, f];
    onFiltersChange(ALL_TASK_FILTERS.filter(x => next.includes(x)));
  };

  // Sectioning & Sorting
  const sections = useMemo(() => {
    const tomorrowStr = format(addDays(new Date(`${today}T00:00:00`), 1), 'yyyy-MM-dd');
    const openSecs: Record<string, Row[]> = { Overdue: [], Today: [], Tomorrow: [], Upcoming: [], General: [] };
    const doneSecs: Row[] = [];

    for (const r of rows) {
      const bucket = taskBucket(r.task, r.due, today);
      const visible = !filters.length || (r.done ? filters.includes('completed') : filters.includes(bucket));
      if (!visible) continue;
      if (r.done) { doneSecs.push(r); continue; }
      if (!r.due) openSecs.General.push(r);
      else if (r.due < today) openSecs.Overdue.push(r);
      else if (r.due === today) openSecs.Today.push(r);
      else if (r.due === tomorrowStr) openSecs.Tomorrow.push(r);
      else openSecs.Upcoming.push(r);
    }

    const sortFn = (a: Row, b: Row) => {
      if (sortMode === 'manual') {
        return (a.task.order ?? 0) - (b.task.order ?? 0)
          || (a.due ?? '9999').localeCompare(b.due ?? '9999')
          || a.task.title.localeCompare(b.task.title);
      }
      if (sortMode === 'title') {
        return a.task.title.localeCompare(b.task.title);
      }
      if (sortMode === 'title-desc') {
        return b.task.title.localeCompare(a.task.title);
      }
      // 'datetime' (default)
      return (a.due ?? '9999').localeCompare(b.due ?? '9999')
        || (a.task.startTime ?? '99:99').localeCompare(b.task.startTime ?? '99:99')
        || (a.task.order ?? 0) - (b.task.order ?? 0)
        || a.task.title.localeCompare(b.task.title);
    };

    for (const k of Object.keys(openSecs)) openSecs[k].sort(sortFn);
    doneSecs.sort((a, b) => (b.task.completedAt ?? 0) - (a.task.completedAt ?? 0));
    return { open: openSecs, done: doneSecs };
  }, [rows, filters, today, sortMode]);

  const openCount = counts.today + counts.overdue + counts.upcoming + counts.general;
  const visibleOpenCount = useMemo(
    () => Object.values(sections.open).reduce((sum, list) => sum + list.length, 0),
    [sections.open],
  );
  const visibleCount = visibleOpenCount + sections.done.length;
  const totalCount = openCount + counts.completed;

  const applyManualOrder = useCallback((orderedRows: Row[]) => {
    orderedRows.forEach((r, idx) => {
      onEdit(r.occId, { order: idx * 10 });
    });
    if (sortMode !== 'manual') {
      setSortMode('manual');
    }
  }, [onEdit, sortMode]);

  const handleDropTask = useCallback((sourceOccId: string, targetOccId: string, edge: InsertEdge, sectionList: Row[]) => {
    if (sourceOccId === targetOccId) return;

    const sourceIndex = sectionList.findIndex(r => r.occId === sourceOccId);
    if (sourceIndex === -1) return;

    const reordered = [...sectionList];
    const [moved] = reordered.splice(sourceIndex, 1);

    const targetIndex = reordered.findIndex(r => r.occId === targetOccId);
    // A row in a DIFFERENT section is not a reorder target. Appending to the end
    // (what this did) meant a drag that overshot into Tomorrow or Completed sent
    // the task to the bottom of its own section instead — and, worse, flipped
    // the whole panel to manual sort while doing it. Do nothing rather than
    // something the user never pointed at.
    if (targetIndex === -1) return;
    reordered.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, moved);

    applyManualOrder(reordered);
  }, [applyManualOrder]);

  // ── List mutations ─────────────────────────────────────────────────────────
  const saveList = useCallback((id: string | 'new', name: string, color: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (id === 'new') {
      const fresh = { id: makeListId(trimmed), name: trimmed, color };
      onListsChange([...lists, fresh]);
      onActiveListChange(fresh.id);
    } else {
      onListsChange(lists.map(l => (l.id === id ? { ...l, name: trimmed, color } : l)));
    }
    setListEditor(null);
  }, [lists, onListsChange, onActiveListChange]);

  const shiftList = useCallback((id: string, dir: -1 | 1) => {
    onListsChange(moveList(lists, id, dir));
  }, [lists, onListsChange]);

  const removeList = useCallback((id: string, mode: ListDeleteMode) => {
    // Leave the tab you were standing on before it disappears, or the panel
    // spends a render pointing at a list that is already gone.
    if (activeListId === id) onActiveListChange(null);
    setListEditor(null);
    onDeleteList(id, mode);
  }, [activeListId, onActiveListChange, onDeleteList]);

  // ── Reordering the rail ────────────────────────────────────────────────────
  // Same hook the Settings lists use, just on the horizontal axis. The default
  // ignore-selector is narrowed because a pill IS a button — only the chevron
  // that opens the editor is off-limits.
  const rail = useReorder<TaskListDef, HTMLDivElement>(lists, l => l.id, onListsChange, {
    axis: 'x',
    ignore: '[data-no-drag]',
  });

  /** Drop a dragged task onto a list pill. */
  const dropTaskOnList = useCallback((occId: string, listId: string) => {
    setDragOverListId(null);
    setDraggingId(null);
    setDragOverId(null);
    const row = allRows.find(r => r.occId === occId);
    if (!row) return;
    // A subtask follows its parent, so filing one means filing the parent.
    const targetOccId = row.task.parentId && tasks[row.task.parentId] ? row.task.parentId : occId;
    if (listOfTask(row.task) === listId) return;
    onMoveTaskToList(targetOccId, listId);
  }, [allRows, tasks, listOfTask, onMoveTaskToList]);

  const [sheetDragY, setSheetDragY] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetStartRef = useRef<number | null>(null);
  const sheetDragRafRef = useRef<number | null>(null);
  // A sheet reopened after being dragged must start flush, never mid-pull.
  useEffect(() => {
    if (!open) {
      if (sheetDragRafRef.current !== null) {
        cancelAnimationFrame(sheetDragRafRef.current);
        sheetDragRafRef.current = null;
      }
      setSheetDragY(0);
      setSheetDragging(false);
      sheetStartRef.current = null;
    }
  }, [open]);

  // Resize drag handle
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    // Resizing changes the calendar's width, so every reported width costs a full
    // grid re-layout. Mice report far more often than the screen repaints, so run
    // the resize at most once per frame with the newest position.
    let pendingX = 0;
    let frame = 0;
    const apply = () => {
      frame = 0;
      if (!dragRef.current) return;
      onResize(dragRef.current.startW + (dragRef.current.startX - pendingX));
    };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      pendingX = ev.clientX;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const up = () => {
      if (frame) { cancelAnimationFrame(frame); frame = 0; apply(); }
      dragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const chip = theme.chip(taskColor);
  /** The panel takes on the colour of whichever list you're looking at. */
  const headerTone = activeList?.color ?? taskColor;
  const composerListColor = listsById[composerListId]?.color ?? taskColor;

  const handleToggleDoneAnimated = useCallback((occId: string, currentlyDone: boolean) => {
    if (currentlyDone) {
      const timer = doneTimersRef.current[occId];
      if (timer) {
        window.clearTimeout(timer);
        delete doneTimersRef.current[occId];
      }
      setPendingDoneIds(prev => {
        if (!prev[occId]) return prev;
        const next = { ...prev };
        delete next[occId];
        return next;
      });
      onToggleDone(occId);
      return;
    }

    setPendingDoneIds(prev => ({ ...prev, [occId]: true }));
    const existing = doneTimersRef.current[occId];
    if (existing) window.clearTimeout(existing);
    doneTimersRef.current[occId] = window.setTimeout(() => {
      delete doneTimersRef.current[occId];
      onToggleDone(occId);
      setPendingDoneIds(prev => {
        const next = { ...prev };
        delete next[occId];
        return next;
      });
    }, 420);
  }, [onToggleDone]);

  return (
    <MotionConfig reducedMotion={vp.isPhone ? 'always' : 'never'}>
    <>
      {/* Phone: the dimmed backdrop. Tapping it is the fastest way out, which
          matters because the sheet covers the calendar you were just reading. */}
      {sheet && !page && (
        <div
          onClick={onClose}
          aria-hidden
          className="fixed inset-0 z-[80]"
          style={{
            // Flat, not blurred: a backdrop-filter here forces the whole
            // calendar underneath to be re-blurred on every frame the sheet
            // slides, which is exactly the stutter this panel used to have.
            background: 'rgba(0,0,0,0.55)',
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: vp.isPhone ? 'none' : 'opacity 220ms ease',
          }}
        />
      )}
    <aside
      className={page
        ? 'fixed inset-x-0 top-0 z-[81] overflow-hidden'
        : sheet
        ? 'fixed inset-x-0 bottom-0 z-[81] overflow-hidden shadow-2xl gpu-layer'
        : 'flex-shrink-0 overflow-hidden relative shadow-lg'}
      style={{
        ...(page ? {
          // Its own screen, not a sheet over the calendar: no scrim to composite,
          // no slide to animate and nothing rendered underneath. Switching tabs is
          // a plain show/hide, which is the only version of this that can't drop
          // frames on a phone.
          bottom: vp.keyboardInset > 0 ? `${vp.keyboardInset}px` : 'var(--bottom-nav-h)',
          paddingTop: 'var(--safe-top)',
          background: theme.menuBg,
          display: open ? undefined : 'none',
        } : sheet ? {
          // Stops at the tab bar rather than sliding under it: the bar stays
          // usable (tap Calendar to get straight back) and the composer at the
          // foot of the list is never hidden behind it.
          bottom: vp.keyboardInset > 0 ? `${vp.keyboardInset}px` : 'var(--bottom-nav-h)',
          // Not full height — leaving the top of the calendar peeking through is
          // what makes a sheet read as "on top of" rather than "instead of", and
          // it gives the eye somewhere to tap to dismiss.
          height: vp.keyboardInset > 0 ? `calc(100% - ${vp.keyboardInset}px)` : 'calc(86dvh - var(--bottom-nav-h))',
          borderTopLeftRadius: 18,
          borderTopRightRadius: 18,
          borderTop: `1px solid ${theme.surfaceBdr}`,
          background: theme.menuBg,
          transform: open ? `translateY(${sheetDragY}px)` : 'translateY(110%)',
          // No transition while a finger is on the handle — the sheet has to
          // track the drag exactly, or it feels like it's on elastic.
          transition: sheetDragging ? 'none' : 'transform 180ms cubic-bezier(0.22, 1, 0.36, 1)',
          visibility: open ? 'visible' : 'hidden',
          // Keep the sheet on its own compositor layer and stop its contents from
          // participating in the page's layout/paint while it slides.
          willChange: 'transform',
          contain: 'paint',
        } : {
          // Plain CSS transition rather than a JS-driven one. Width is a layout
          // property either way, but framer-motion also ran a per-frame rAF that
          // wrote inline styles from JS — on top of the reflow the calendar next
          // door already owes, that extra main-thread work is what made the
          // show/hide stutter. The browser drives this one on its own.
          // No will-change: width is not a compositable property, so declaring it
          // buys nothing and keeps the panel permanently promoted to its own
          // layer that has to be re-rastered every time its contents change.
          width: open ? width : 0,
          // 130ms, not 200ms: each frame of this animation costs the calendar next
          // door a full re-layout, so the cheapest thing we can do is ask for fewer
          // of them. The easing keeps most of the travel in the first third, so it
          // still reads as a slide rather than a jump.
          transition: 'width 130ms cubic-bezier(0.16, 1, 0.3, 1)',
          borderLeft: open ? `1px solid ${theme.surfaceBdr}` : 'none',
        }),
        ...(zoom && zoom !== 1 ? { zoom } : {}),
      }}
      aria-hidden={!open}
    >
      {/* Fixed inner width so the panel's own contents never re-layout while the
          shell animates — only the shell's clip rectangle moves. */}
      <div className="h-full flex flex-col select-none" style={{ width: sheet ? '100%' : width, background: theme.menuBg }}>
        {page ? null : sheet ? (
          /* Grab handle. Swiping it down past a third of the sheet dismisses;
             anything less springs back, so a hesitant drag never loses the list. */
          <div
            className="flex-shrink-0 flex items-center justify-center py-2.5 cursor-grab"
            style={{ touchAction: 'none' }}
            onPointerDown={e => {
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              sheetStartRef.current = e.clientY;
              setSheetDragging(true);
            }}
            onPointerMove={e => {
              if (sheetStartRef.current === null) return;
              const dy = Math.max(0, e.clientY - sheetStartRef.current);
              if (sheetDragRafRef.current === null) {
                sheetDragRafRef.current = requestAnimationFrame(() => {
                  sheetDragRafRef.current = null;
                  setSheetDragY(dy);
                });
              }
            }}
            onPointerUp={e => {
              if (sheetDragRafRef.current !== null) {
                cancelAnimationFrame(sheetDragRafRef.current);
                sheetDragRafRef.current = null;
              }
              if (sheetStartRef.current === null) return;
              const travelled = e.clientY - sheetStartRef.current;
              sheetStartRef.current = null;
              setSheetDragging(false);
              setSheetDragY(0);
              if (travelled > (e.currentTarget as HTMLElement).ownerDocument.defaultView!.innerHeight * 0.18) onClose();
            }}
            onPointerCancel={() => {
              if (sheetDragRafRef.current !== null) {
                cancelAnimationFrame(sheetDragRafRef.current);
                sheetDragRafRef.current = null;
              }
              sheetStartRef.current = null;
              setSheetDragging(false);
              setSheetDragY(0);
            }}
          >
            <div className="w-10 h-1 rounded-full" style={{ background: theme.surfaceBdr, opacity: 0.9 }} />
          </div>
        ) : (
          /* Resize handle */
          <div
            onMouseDown={onHandleDown}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-30 transition-colors"
            onMouseEnter={e => (e.currentTarget.style.background = `${theme.accent}55`)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title="Drag to resize tasks panel"
          />
        )}

        {/* Header */}
        <div
          className="min-h-14 flex-shrink-0 flex items-center justify-between gap-3 px-3.5 py-2.5 border-b"
          style={{ borderColor: theme.surfaceBdr, background: theme.surfaceBg + '30' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="p-1.5 rounded-lg flex-shrink-0" style={{ background: `${headerTone}18`, color: headerTone }}>
              {activeList ? <ListTodo size={16} /> : <Layers size={16} />}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm font-semibold tracking-tight truncate" style={{ color: theme.menuText }}>
                  {activeList ? activeList.name : 'Tasks'}
                </span>
                {openCount > 0 && (
                  <span
                    className="text-[10.5px] font-bold px-1.5 py-0.5 rounded-full tabular-nums flex-shrink-0"
                    style={{ background: chip.bg, color: chip.text, border: `1px solid ${chip.border}` }}
                  >
                    {openCount}
                  </span>
                )}
              </div>
              <div className="text-[10.5px] leading-tight truncate" style={{ color: theme.menuSub }}>
                {totalCount === 0
                  ? (activeList ? `Nothing in ${activeList.name}` : 'No tasks yet')
                  : `${visibleCount} shown${activeList ? '' : lists.length > 1 ? ` · ${lists.length} lists` : ''}`}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Sort Menu Button */}
            <div className="relative">
              <button
                onClick={() => setShowSortMenu(v => !v)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-smooth hover:scale-[1.02] active:scale-95"
                style={{
                  background: theme.surfaceBg,
                  border: `1px solid ${theme.surfaceBdr}`,
                  color: theme.menuSub,
                }}
                title="Sort tasks"
              >
                <ArrowUpDown size={13} style={{ color: theme.accent }} />
                <span className="hidden sm:inline text-[11px]">{SORT_LABELS[sortMode]}</span>
                <ChevronDown size={11} />
              </button>

              {showSortMenu && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSortMenu(false)} />
                  <div
                    className="absolute right-0 top-full mt-1.5 z-50 w-44 rounded-xl shadow-xl py-1.5 border"
                    style={{ background: theme.menuBg, borderColor: theme.surfaceBdr }}
                  >
                    <div className="px-3 py-1 text-[10px] font-bold uppercase tracking-wider" style={{ color: theme.menuSub }}>
                      Sort Tasks By
                    </div>
                    {(Object.keys(SORT_LABELS) as SortMode[]).map(mode => (
                      <button
                        key={mode}
                        onClick={() => { setSortMode(mode); setShowSortMenu(false); }}
                        className="w-full flex items-center justify-between px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-90"
                        style={{
                          background: sortMode === mode ? `${theme.accent}18` : 'transparent',
                          color: sortMode === mode ? theme.accent : theme.menuText,
                        }}
                      >
                        <span>{SORT_LABELS[mode]}</span>
                        {sortMode === mode && <Check size={12} strokeWidth={2.5} />}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <button
              onClick={onClose}
              className="p-1.5 rounded-lg transition-smooth hover:scale-105 active:scale-95"
              style={{ color: theme.menuSub }}
              onMouseEnter={e => (e.currentTarget.style.background = theme.hoverBg)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              title="Close tasks panel"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* ── List rail ────────────────────────────────────────────────────
            The lists themselves live here rather than behind a Settings trip:
            switching, creating, renaming, recolouring, reordering and deleting
            all happen on the page you're already looking at. A task can also be
            dropped straight onto a pill to file it. */}
        <div className="flex-shrink-0 relative border-b" style={{ borderColor: theme.surfaceBdr }}>
          <div
            ref={rail.containerRef}
            className="flex gap-1.5 px-3 py-2 overflow-x-auto overflow-y-hidden no-scrollbar touch-scroll-x"
            style={{ background: theme.surfaceBg + '22' }}
          >
            <ListPill
              label="All"
              icon={<Layers size={11} />}
              tone={theme.accent}
              active={effectiveListId === null}
              count={lists.length > 1 ? Object.values(listCounts).reduce((a, b) => a + b, 0) : undefined}
              theme={theme}
              onClick={() => onActiveListChange(null)}
            />
            {lists.map((l, i) => (
              <React.Fragment key={l.id}>
                <RailInsertBar active={rail.dropIndex === i && rail.dragId !== null} theme={theme} />
                <ListPill
                  listId={l.id}
                  label={l.name}
                  tone={l.color}
                  active={effectiveListId === l.id}
                  count={listCounts[l.id]}
                  theme={theme}
                  editable
                  reorderable={lists.length > 1}
                  beingDragged={rail.dragId === l.id}
                  dragDelta={rail.dragId === l.id ? rail.dragDelta : 0}
                  dragActive={!!draggingId}
                  dropActive={dragOverListId === l.id}
                  onPointerDownPill={e => rail.startDrag(e, l.id)}
                  onClick={() => { if (!rail.wasDragged()) onActiveListChange(l.id); }}
                  onEdit={() => setListEditor(prev => (prev === l.id ? null : l.id))}
                  onDragOverList={() => setDragOverListId(l.id)}
                  onDragLeaveList={() => setDragOverListId(prev => (prev === l.id ? null : prev))}
                  onDropTask={occId => dropTaskOnList(occId, l.id)}
                />
              </React.Fragment>
            ))}
            <RailInsertBar active={rail.dropIndex === lists.length && rail.dragId !== null} theme={theme} />
            <button
              onClick={() => setListEditor(prev => (prev === 'new' ? null : 'new'))}
              className="flex-shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-smooth hover:scale-[1.02] active:scale-95"
              style={{
                background: listEditor === 'new' ? `${theme.accent}22` : 'transparent',
                border: `1px solid ${listEditor === 'new' ? theme.accent : theme.surfaceBdr}`,
                color: listEditor === 'new' ? theme.accent : theme.menuSub,
              }}
              title="New list"
            >
              <Plus size={11} strokeWidth={2.6} />
              {lists.length <= 1 && <span>New list</span>}
            </button>
          </div>

          <AnimatePresence>
            {listEditor && (
              <ListEditor
                key={listEditor}
                list={listEditor === 'new' ? null : listsById[listEditor] ?? null}
                lists={lists}
                taskCount={listEditor === 'new' ? 0 : listCounts[listEditor] ?? 0}
                theme={theme}
                onSave={(name, color) => saveList(listEditor, name, color)}
                onMove={dir => shiftList(listEditor, dir)}
                onDelete={mode => removeList(listEditor, mode)}
                onClose={() => setListEditor(null)}
              />
            )}
          </AnimatePresence>
        </div>

        {/* Filter chips */}
        <div
          className="flex-shrink-0 px-3 py-2 flex gap-1.5 border-b overflow-x-auto overflow-y-hidden no-scrollbar touch-scroll-x"
          style={{ borderColor: theme.surfaceBdr, background: theme.menuBg }}
        >
          <FilterChip
            label="All"
            active={filters.length === 0}
            theme={theme}
            onClick={() => onFiltersChange([])}
          />
          {ALL_TASK_FILTERS.map(f => (
            <FilterChip
              key={f}
              label={TASK_FILTER_LABELS[f]}
              count={counts[f]}
              active={filters.includes(f)}
              danger={f === 'overdue'}
              theme={theme}
              onClick={() => toggleFilter(f)}
            />
          ))}
        </div>

        {/* Task Composer */}
        <div className="flex-shrink-0 px-3 py-3 border-b" style={{ borderColor: theme.surfaceBdr }}>
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl transition-smooth shadow-sm"
            style={{
              background: theme.surfaceBg,
              border: `1.5px solid ${composerFocused ? theme.accent : theme.surfaceBdr}`,
              boxShadow: composerFocused
                ? `0 0 0 3px ${theme.accent}18, 0 8px 24px rgba(0,0,0,${theme.darkMode ? 0.22 : 0.07})`
                : 'none',
            }}
          >
            <Plus size={16} style={{ color: composerFocused ? theme.accent : theme.menuSub }} />
            <input
              ref={inputRef}
              value={composerTitle}
              onChange={e => setComposerTitle(e.target.value)}
              onFocus={() => setComposerFocused(true)}
              onBlur={() => setComposerFocused(false)}
              onKeyDown={e => {
                if (e.key === 'Enter') { e.preventDefault(); submitComposer(); }
                else if (e.key === 'Escape') { e.currentTarget.blur(); resetComposer(); }
              }}
              placeholder="Add a new task..."
              className="flex-1 bg-transparent outline-none text-[13px] font-medium min-w-0"
              style={{ color: theme.menuText }}
            />
            <AnimatePresence>
              {composerTitle.trim() && (
                <motion.button
                  initial={{ scale: 0.85, opacity: 0 }}
                  animate={{ scale: 1, opacity: 1 }}
                  exit={{ scale: 0.85, opacity: 0 }}
                  transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
                  onMouseDown={e => e.preventDefault()}
                  onClick={submitComposer}
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-smooth hover:scale-[1.02] active:scale-95"
                  style={{ background: theme.accent, color: theme.darkMode ? '#0b1220' : '#ffffff' }}
                >
                  Add
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          {/* Composer Schedule Bar (Date & Time & Repeat & Options Picker) */}
          <AnimatePresence initial={false}>
            {(composerFocused || composerTitle.trim() || composerDate !== today || composerTime || composerRecur || composerNotes.trim() || showTimePicker || showRepeatPicker || showNotesInput) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="flex flex-col gap-2.5 pt-2.5 overflow-visible"
              >
                {/* Schedule Card Container */}
                <div
                  className="rounded-xl p-2.5 flex flex-col gap-2.5"
                  style={{ background: theme.surfaceBg + '70', border: `1px solid ${theme.surfaceBdr}` }}
                >
                  {/* Date selection row */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-bold uppercase tracking-wider mr-0.5" style={{ color: theme.menuSub }}>Date</span>
                    <QuickPill
                      icon={<Sun size={12} />}
                      label="Today"
                      title={`Today (${format(new Date(`${today}T00:00:00`), 'd/M/yyyy')})`}
                      active={composerDate === today}
                      theme={theme}
                      onClick={() => setComposerDate(today)}
                    />
                    <QuickPill
                      icon={<ArrowRight size={12} />}
                      label="Tomorrow"
                      title={`Tomorrow (${format(new Date(`${tomorrow}T00:00:00`), 'd/M/yyyy')})`}
                      active={composerDate === tomorrow}
                      theme={theme}
                      onClick={() => setComposerDate(tomorrow)}
                    />
                    <QuickPill
                      icon={<X size={12} />}
                      label="No Date"
                      active={composerDate === null}
                      theme={theme}
                      onClick={() => {
                        setComposerDate(null);
                        setComposerTime(null);
                        setComposerRecur(undefined);
                      }}
                    />

                    {/* Custom Date Input Picker Button */}
                    <label
                      className="relative flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-smooth hover:opacity-90 active:scale-95"
                      style={{
                        background: (composerDate && composerDate !== today && composerDate !== tomorrow)
                          ? `${theme.accent}22` : theme.surfaceBg,
                        border: `1px solid ${(composerDate && composerDate !== today && composerDate !== tomorrow)
                          ? theme.accent : theme.surfaceBdr}`,
                        color: (composerDate && composerDate !== today && composerDate !== tomorrow)
                          ? theme.accent : theme.menuSub,
                        fontWeight: (composerDate && composerDate !== today && composerDate !== tomorrow) ? 600 : 500,
                      }}
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => {
                        dateInputRef.current?.focus();
                        try { dateInputRef.current?.showPicker?.(); } catch {}
                      }}
                      title="Choose custom date"
                    >
                      <Calendar size={12} />
                      <span>
                        {(composerDate && composerDate !== today && composerDate !== tomorrow)
                          ? format(new Date(`${composerDate}T00:00:00`), 'MMM d')
                          : 'Pick Date'}
                      </span>
                      <input
                        ref={dateInputRef}
                        type="date"
                        value={composerDate ?? ''}
                        onChange={e => setComposerDate(e.target.value || null)}
                        className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                      />
                    </label>
                  </div>

                  {/* Options row: Time, Repeat, List, Notes */}
                  <div className="flex items-center gap-2 flex-wrap pt-2 border-t" style={{ borderColor: theme.surfaceBdr }}>
                    <span className="text-[10px] font-bold uppercase tracking-wider mr-0.5" style={{ color: theme.menuSub }}>Options</span>

                    {/* Time Picker */}
                    <div className="flex items-center gap-1">
                      <div className="relative">
                        <button
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            if (!composerDate) setComposerDate(today);
                            setShowTimePicker(v => !v);
                          }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-smooth hover:scale-[1.02] active:scale-95"
                          style={{
                            background: composerTime ? chip.bg : theme.surfaceBg,
                            border: `1px solid ${composerTime ? chip.border : theme.surfaceBdr}`,
                            color: composerTime ? chip.text : theme.menuSub,
                            fontWeight: composerTime ? 600 : 500,
                          }}
                          title="Set task time"
                        >
                          <Clock size={12} />
                          <span>{composerTime ? fmtTime(composerTime, timeFormat) : 'Time'}</span>
                        </button>

                        <AnimatePresence>
                          {showTimePicker && (
                            <TimePickerPopover
                              value={composerTime}
                              timeFormat={timeFormat}
                              theme={theme}
                              taskColor={taskColor}
                              onChange={setComposerTime}
                              onClose={() => setShowTimePicker(false)}
                            />
                          )}
                        </AnimatePresence>
                      </div>

                      {composerTime && (
                        <button
                          onClick={() => { setComposerTime(null); setShowTimePicker(false); }}
                          className="p-1 rounded-lg hover:bg-red-500/20 text-red-400 transition-colors"
                          title="Clear time"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>

                    {/* Repeat Picker */}
                    <div className="flex items-center gap-1">
                      <div className="relative">
                        <button
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => {
                            if (!composerDate) setComposerDate(today);
                            setShowRepeatPicker(v => !v);
                          }}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-smooth hover:scale-[1.02] active:scale-95"
                          style={{
                            background: composerRecur ? `${theme.accent}20` : theme.surfaceBg,
                            border: `1px solid ${composerRecur ? theme.accent : theme.surfaceBdr}`,
                            color: composerRecur ? theme.accent : theme.menuSub,
                            fontWeight: composerRecur ? 600 : 500,
                          }}
                          title={composerRecur ? `Repeats: ${formatRecurrenceLabel(composerRecur, composerDate || today)}` : 'Set task repetition'}
                        >
                          <Repeat size={12} />
                          <span className="truncate max-w-[130px]">
                            {composerRecur ? formatRecurrenceLabel(composerRecur, composerDate || today) : 'Repeat'}
                          </span>
                        </button>

                        <AnimatePresence>
                          {showRepeatPicker && (
                            <RepeatPickerPopover
                              value={composerRecur}
                              anchorDate={composerDate}
                              today={today}
                              theme={theme}
                              taskColor={taskColor}
                              onChange={r => {
                                if (r && !composerDate) setComposerDate(today);
                                setComposerRecur(r);
                              }}
                              onClose={() => setShowRepeatPicker(false)}
                            />
                          )}
                        </AnimatePresence>
                      </div>

                      {composerRecur && (
                        <button
                          onClick={() => { setComposerRecur(undefined); setShowRepeatPicker(false); }}
                          className="p-1 rounded-lg hover:bg-red-500/20 text-red-400 transition-colors"
                          title="Clear repeat"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </div>

                    {/* Which list this one goes to (if multiple lists exist) */}
                    {lists.length > 1 && (
                      <div className="relative">
                        <button
                          type="button"
                          onMouseDown={e => e.preventDefault()}
                          onClick={() => setShowListPicker(v => !v)}
                          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-smooth hover:scale-[1.02] active:scale-95"
                          style={{
                            background: `${composerListColor}18`,
                            border: `1px solid ${composerListColor}66`,
                            color: composerListColor,
                          }}
                          title="Choose which list this task goes to"
                        >
                          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: composerListColor }} />
                          <span className="truncate max-w-[110px]">{listsById[composerListId]?.name ?? 'General'}</span>
                          <ChevronDown size={11} />
                        </button>

                        {showListPicker && (
                          <>
                            <div className="fixed inset-0 z-40" onMouseDown={() => setShowListPicker(false)} onPointerDown={() => setShowListPicker(false)} />
                            <div
                              className="absolute left-0 top-full mt-1.5 z-50 w-48 max-h-56 overflow-y-auto rounded-xl shadow-xl py-1.5 border"
                              style={{ background: theme.menuBg, borderColor: theme.surfaceBdr }}
                              onMouseDown={e => e.preventDefault()}
                            >
                              {lists.map(l => (
                                <button
                                  key={l.id}
                                  onClick={() => { setComposerListId(l.id); setShowListPicker(false); }}
                                  className="w-full flex items-center gap-2 px-3 py-1.5 text-xs font-medium transition-colors hover:opacity-90"
                                  style={{
                                    background: composerListId === l.id ? `${l.color}18` : 'transparent',
                                    color: composerListId === l.id ? l.color : theme.menuText,
                                  }}
                                >
                                  <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: l.color }} />
                                  <span className="flex-1 text-left truncate">{l.name}</span>
                                  {composerListId === l.id && <Check size={12} strokeWidth={2.5} />}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}

                    {/* Note Toggle */}
                    <button
                      type="button"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => setShowNotesInput(v => !v)}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-smooth hover:scale-[1.02] active:scale-95"
                      style={{
                        background: (showNotesInput || composerNotes.trim()) ? `${theme.accent}18` : theme.surfaceBg,
                        border: `1px solid ${(showNotesInput || composerNotes.trim()) ? theme.accent : theme.surfaceBdr}`,
                        color: (showNotesInput || composerNotes.trim()) ? theme.accent : theme.menuSub,
                        fontWeight: (showNotesInput || composerNotes.trim()) ? 600 : 500,
                      }}
                      title="Add description or notes to this task"
                    >
                      <StickyNote size={12} />
                      <span>{composerNotes.trim() ? 'Note added' : '+ Note'}</span>
                    </button>
                  </div>

                  {/* Expandable Note Input */}
                  <AnimatePresence>
                    {(showNotesInput || composerNotes.trim().length > 0) && (
                      <motion.div
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: 'auto' }}
                        exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: 0.15 }}
                        className="pt-2 border-t overflow-hidden"
                        style={{ borderColor: theme.surfaceBdr }}
                      >
                        <div className="relative">
                          <textarea
                            value={composerNotes}
                            onChange={e => setComposerNotes(e.target.value)}
                            placeholder="Add task notes or details..."
                            rows={2}
                            className="w-full rounded-xl px-2.5 py-1.5 text-xs outline-none resize-none transition-smooth"
                            style={{
                              background: theme.surfaceBg,
                              color: theme.menuText,
                              border: `1px solid ${theme.surfaceBdr}`,
                            }}
                          />
                          {composerNotes.trim() && (
                            <button
                              type="button"
                              onClick={() => setComposerNotes('')}
                              className="absolute right-2 top-2 p-0.5 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                              title="Clear notes"
                            >
                              <X size={11} />
                            </button>
                          )}
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Task List */}
        <div
          className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden touch-scroll px-2.5 py-3 space-y-3 gpu-layer"
          style={{ overscrollBehavior: 'contain', contain: 'content', paddingBottom: page ? 'calc(var(--safe-bottom) + 24px)' : undefined }}
        >
          {visibleCount === 0 && (
            <div
              className="flex flex-col items-center justify-center gap-3 py-14 text-center px-6 rounded-2xl border"
              style={{ background: theme.surfaceBg + '55', borderColor: theme.surfaceBdr }}
            >
              <div className="p-3 rounded-2xl" style={{ background: `${theme.accent}14`, border: `1px solid ${theme.accent}30` }}>
                <Sparkles size={26} style={{ color: theme.accent }} />
              </div>
              <div>
                <h4 className="text-xs font-bold tracking-tight mb-1" style={{ color: theme.menuText }}>
                  {totalCount === 0
                    ? (activeList ? `${activeList.name} is empty` : 'No tasks yet')
                    : 'No tasks match'}
                </h4>
                <p className="text-[11px] leading-relaxed" style={{ color: theme.menuSub }}>
                  {totalCount === 0
                    ? (activeList
                      ? 'Add one above, or drag a task onto this list from All.'
                      : 'Add one above and choose a date when needed.')
                    : 'Try a different filter or clear the filters.'}
                </p>
              </div>
            </div>
          )}

          {Object.entries(sections.open).map(([name, list]) => (
            list.length === 0 ? null : (
              <Section
                key={name}
                name={name}
                label={
                  name === 'Today'
                    ? `Today (${format(new Date(`${today}T00:00:00`), 'd/M/yyyy')})`
                    : name === 'Tomorrow'
                    ? `Tomorrow (${format(new Date(`${tomorrow}T00:00:00`), 'd/M/yyyy')})`
                    : name
                }
                count={list.length}
                danger={name === 'Overdue'}
                collapsed={!!collapsed[name]}
                theme={theme}
                onToggle={() => setCollapsed(c => ({ ...c, [name]: !c[name] }))}
              >
                <TaskList
                  rows={list}
                  today={today}
                  timeFormat={timeFormat}
                  theme={theme}
                  taskColor={taskColor}
                  taskCheckboxShape={taskCheckboxShape}
                  showDate={name === 'Upcoming' || name === 'Overdue'}
                  listOf={listOfTask}
                  listsById={listsById}
                  showListBadge={effectiveListId === null && lists.length > 1}
                  onListHover={setDragOverListId}
                  onMoveToList={dropTaskOnList}
                  expandedParents={expandedParents}
                  draggingId={draggingId}
                  dragOverId={dragOverId}
                  pendingDoneIds={pendingDoneIds}
                  onDragStart={setDraggingId}
                  onDragOver={setDragOverId}
                  onDrop={(srcId, tgtId, edge) => handleDropTask(srcId, tgtId, edge, list)}
                  onToggleExpand={id => setExpandedParents(p => ({ ...p, [id]: !p[id] }))}
                  onToggleDone={handleToggleDoneAnimated}
                  onOpenMenu={onOpenMenu}
                />
              </Section>
            )
          ))}

          {sections.done.length > 0 && (
            <Section
              name="Completed"
              count={sections.done.length}
              collapsed={completedCollapsed}
              theme={theme}
              onToggle={() => setCompletedCollapsed(c => !c)}
            >
              <TaskList
                rows={sections.done}
                today={today}
                timeFormat={timeFormat}
                theme={theme}
                taskColor={taskColor}
                taskCheckboxShape={taskCheckboxShape}
                showDate
                listOf={listOfTask}
                listsById={listsById}
                showListBadge={effectiveListId === null && lists.length > 1}
                onListHover={setDragOverListId}
                onMoveToList={dropTaskOnList}
                expandedParents={expandedParents}
                draggingId={draggingId}
                dragOverId={dragOverId}
                pendingDoneIds={pendingDoneIds}
                onDragStart={setDraggingId}
                onDragOver={setDragOverId}
                onDrop={(srcId, tgtId, edge) => handleDropTask(srcId, tgtId, edge, sections.done)}
                onToggleExpand={id => setExpandedParents(p => ({ ...p, [id]: !p[id] }))}
                onToggleDone={handleToggleDoneAnimated}
                onOpenMenu={onOpenMenu}
              />
            </Section>
          )}
        </div>
      </div>
    </aside>
    </>
    </MotionConfig>
  );
}

/**
 * Memoised. The panel is a sibling of the calendar inside one very large page
 * component, so without this it re-rendered its entire task list on every
 * calendar hover, every drag frame and every clock tick — none of which change
 * a single one of its props.
 */
export default React.memo(TasksPanel);

function TimePickerPopover({ value, timeFormat, theme, taskColor, onChange, onClose }: {
  value: string | null;
  timeFormat: TimeFormat;
  theme: TaskTheme;
  taskColor: string;
  onChange: (time: string | null) => void;
  onClose: () => void;
}) {
  const [hour, minute] = (value ?? '09:00').split(':');
  const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0'));
  const minutes = Array.from({ length: 60 }, (_, m) => String(m).padStart(2, '0'));
  const setPart = (nextHour: string, nextMinute: string) => onChange(`${nextHour}:${nextMinute}`);

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} onPointerDown={onClose} />
      <motion.div
        initial={{ opacity: 0, y: -4, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -4, scale: 0.98 }}
        transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
        className="absolute left-0 top-full mt-2 z-50 w-56 max-w-[calc(100vw-24px)] rounded-xl border p-2 shadow-xl"
        style={{
          background: theme.menuBg,
          borderColor: theme.surfaceBdr,
          boxShadow: theme.darkMode ? '0 18px 40px rgba(0,0,0,0.45)' : '0 18px 40px rgba(15,23,42,0.16)',
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="grid grid-cols-2 gap-1.5 mb-2">
          {TIME_PRESETS.map(t => {
            const active = value === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => { onChange(t); onClose(); }}
                className="px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-smooth hover:scale-[1.02] active:scale-95"
                style={{
                  background: active ? `${taskColor}22` : theme.surfaceBg,
                  border: `1px solid ${active ? taskColor : theme.surfaceBdr}`,
                  color: active ? taskColor : theme.menuText,
                }}
              >
                {fmtTime(t, timeFormat)}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2">
          <select
            value={hour}
            onChange={e => setPart(e.target.value, minute)}
            className="flex-1 rounded-lg px-2 py-1.5 text-xs outline-none"
            style={{ background: theme.surfaceBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
          >
            {hours.map(h => <option key={h} value={h}>{fmtTime(`${h}:00`, timeFormat).replace(':00', '')}</option>)}
          </select>
          <span className="text-xs font-bold" style={{ color: theme.menuSub }}>:</span>
          <select
            value={minute}
            onChange={e => setPart(hour, e.target.value)}
            className="w-20 rounded-lg px-2 py-1.5 text-xs outline-none"
            style={{ background: theme.surfaceBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
          >
            {minutes.map(m => <option key={m} value={m}>{m}</option>)}
          </select>
        </div>

        <div className="flex items-center justify-between gap-2 pt-2 mt-2 border-t" style={{ borderColor: theme.surfaceBdr }}>
          <button
            type="button"
            onClick={() => { onChange(null); onClose(); }}
            className="px-2 py-1 rounded-lg text-[11px] font-semibold transition-colors"
            style={{ color: theme.menuSub }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-2.5 py-1 rounded-lg text-[11px] font-bold"
            style={{ background: taskColor, color: theme.darkMode ? '#0b1220' : '#ffffff' }}
          >
            Done
          </button>
        </div>
      </motion.div>
    </>
  );
}

const SHORT_WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function RepeatPickerPopover({
  value,
  anchorDate,
  today,
  theme,
  taskColor,
  onChange,
  onClose,
}: {
  value: Recurrence | undefined;
  anchorDate: string | null;
  today: string;
  theme: TaskTheme;
  taskColor: string;
  onChange: (recur: Recurrence | undefined) => void;
  onClose: () => void;
}) {
  const effectiveAnchor = anchorDate || today;
  const anchorWeekday = (parseDate(effectiveAnchor).getDay()) as Weekday;

  // Determine which preset matches
  const currentPreset = useMemo((): string => {
    if (!value) return 'none';
    if (value.freq === 'daily' && value.interval === 1 && !value.end) return 'daily';
    if (
      value.freq === 'weekly' &&
      value.interval === 1 &&
      !value.end &&
      value.byWeekday?.length === 5 &&
      [1, 2, 3, 4, 5].every(d => value.byWeekday!.includes(d as Weekday))
    ) {
      return 'weekdays';
    }
    if (
      value.freq === 'weekly' &&
      value.interval === 1 &&
      !value.end &&
      (!value.byWeekday || (value.byWeekday.length === 1 && value.byWeekday[0] === anchorWeekday))
    ) {
      return 'weekly';
    }
    if (value.freq === 'monthly' && value.interval === 1 && !value.end) return 'monthly';
    if (value.freq === 'yearly' && value.interval === 1 && !value.end) return 'yearly';
    return 'custom';
  }, [value, anchorWeekday]);

  const [isCustom, setIsCustom] = useState(() => currentPreset === 'custom');
  const showCustom = isCustom || currentPreset === 'custom';

  const selectPreset = (p: string) => {
    if (p === 'none') {
      setIsCustom(false);
      onChange(undefined);
      return;
    }
    if (p === 'daily') {
      setIsCustom(false);
      onChange({ freq: 'daily', interval: 1 });
      return;
    }
    if (p === 'weekdays') {
      setIsCustom(false);
      onChange({ freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5] });
      return;
    }
    if (p === 'weekly') {
      setIsCustom(false);
      onChange({ freq: 'weekly', interval: 1, byWeekday: [anchorWeekday] });
      return;
    }
    if (p === 'monthly') {
      setIsCustom(false);
      onChange({ freq: 'monthly', interval: 1 });
      return;
    }
    if (p === 'yearly') {
      setIsCustom(false);
      onChange({ freq: 'yearly', interval: 1 });
      return;
    }
    if (p === 'custom') {
      setIsCustom(true);
      if (!value) onChange({ freq: 'weekly', interval: 1, byWeekday: [anchorWeekday] });
    }
  };

  const r: Recurrence = value ?? { freq: 'weekly', interval: 1, byWeekday: [anchorWeekday] };
  const patch = (d: Partial<Recurrence>) => onChange({ ...r, ...d });
  const endType: 'never' | 'until' | 'count' = !r.end ? 'never' : 'count' in r.end ? 'count' : 'until';

  const WD_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const WD_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} onPointerDown={onClose} />
      <motion.div
        initial={{ opacity: 0, y: -6, scale: 0.96 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.96 }}
        transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
        className="absolute left-0 top-full mt-2 z-50 w-72 max-w-[calc(100vw-24px)] max-h-[80vh] overflow-y-auto rounded-2xl border p-3 shadow-2xl space-y-3"
        style={{
          background: theme.menuBg,
          borderColor: theme.surfaceBdr,
          boxShadow: theme.darkMode ? '0 20px 48px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset' : '0 20px 48px rgba(15,23,42,0.18)',
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between pb-2 border-b" style={{ borderColor: theme.surfaceBdr }}>
          <div className="flex items-center gap-1.5">
            <Repeat size={13} style={{ color: theme.accent }} />
            <span className="text-xs font-bold" style={{ color: theme.menuText }}>Repeat Task</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="touch-target p-1 rounded-lg hover:opacity-75 transition-opacity"
            style={{ color: theme.menuSub }}
          >
            <X size={13} />
          </button>
        </div>

        {/* Presets Grid */}
        <div className="grid grid-cols-2 gap-1.5">
          {[
            { id: 'none', label: "Doesn't repeat", icon: <X size={11} /> },
            { id: 'daily', label: 'Daily', icon: <Sun size={11} /> },
            { id: 'weekdays', label: 'Weekdays', icon: <CalendarRange size={11} /> },
            { id: 'weekly', label: `Weekly (${SHORT_WD[anchorWeekday]})`, icon: <Calendar size={11} /> },
            { id: 'monthly', label: 'Monthly', icon: <Layers size={11} /> },
            { id: 'yearly', label: 'Yearly', icon: <Sparkles size={11} /> },
          ].map(p => {
            const active = (!showCustom && currentPreset === p.id) || (p.id === 'none' && !value && !showCustom);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => selectPreset(p.id)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-medium transition-smooth hover:scale-[1.02] active:scale-95 text-left"
                style={{
                  background: active ? `${theme.accent}20` : theme.surfaceBg,
                  border: `1px solid ${active ? theme.accent : theme.surfaceBdr}`,
                  color: active ? theme.accent : theme.menuText,
                  fontWeight: active ? 600 : 500,
                }}
              >
                <span className="opacity-70">{p.icon}</span>
                <span className="truncate">{p.label}</span>
              </button>
            );
          })}
        </div>

        {/* Custom Button */}
        <button
          type="button"
          onClick={() => selectPreset('custom')}
          className="w-full flex items-center justify-between px-3 py-2 rounded-xl text-xs font-medium transition-smooth hover:scale-[1.01] active:scale-95"
          style={{
            background: showCustom ? `${theme.accent}20` : theme.surfaceBg,
            border: `1px solid ${showCustom ? theme.accent : theme.surfaceBdr}`,
            color: showCustom ? theme.accent : theme.menuText,
            fontWeight: showCustom ? 600 : 500,
          }}
        >
          <div className="flex items-center gap-1.5">
            <MoreHorizontal size={12} />
            <span>Custom recurrence…</span>
          </div>
          <ChevronDown size={12} className={`transition-transform duration-200 ${showCustom ? 'rotate-180' : ''}`} />
        </button>

        {/* Custom Controls Expanded */}
        <AnimatePresence>
          {showCustom && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.15 }}
              className="space-y-2.5 pt-1 overflow-hidden"
            >
              {/* Every N Frequency */}
              <div className="flex items-center gap-2 text-xs" style={{ color: theme.menuText }}>
                <span className="font-medium" style={{ color: theme.menuSub }}>Every</span>
                <input
                  type="number"
                  min={1}
                  max={99}
                  value={r.interval}
                  onChange={e => patch({ interval: Math.max(1, parseInt(e.target.value || '1', 10)) })}
                  className="w-14 rounded-lg px-2 py-1.5 text-xs text-center font-semibold outline-none"
                  style={{ background: theme.surfaceBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
                />
                <select
                  value={r.freq}
                  onChange={e => patch({ freq: e.target.value as RecurFreq })}
                  className="flex-1 rounded-lg px-2 py-1.5 text-xs font-medium outline-none"
                  style={{ background: theme.surfaceBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
                >
                  <option value="daily">day(s)</option>
                  <option value="weekly">week(s)</option>
                  <option value="monthly">month(s)</option>
                  <option value="yearly">year(s)</option>
                </select>
              </div>

              {/* Weekday Selector (Weekly) */}
              {r.freq === 'weekly' && (
                <div className="space-y-1">
                  <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: theme.menuSub }}>Repeat on</span>
                  <div className="flex justify-between gap-1">
                    {WD_NAMES.map((d, i) => {
                      const days = r.byWeekday ?? [anchorWeekday];
                      const on = days.includes(i as Weekday);
                      return (
                        <button
                          key={i}
                          type="button"
                          title={WD_FULL[i]}
                          onClick={() => {
                            const next = on ? days.filter(x => x !== i) : [...days, i as Weekday];
                            patch({ byWeekday: (next.length ? next : [anchorWeekday]).sort((a, b) => a - b) });
                          }}
                          className="w-8 h-8 rounded-xl text-xs font-bold flex items-center justify-center transition-smooth hover:scale-105 active:scale-95"
                          style={{
                            background: on ? theme.accent : theme.surfaceBg,
                            color: on ? (theme.darkMode ? '#0b1220' : '#ffffff') : theme.menuSub,
                            border: `1px solid ${on ? theme.accent : theme.surfaceBdr}`,
                          }}
                        >
                          {d}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Ends Selector */}
              <div className="space-y-1.5 pt-1">
                <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: theme.menuSub }}>Ends</span>
                <div className="flex items-center gap-2 flex-wrap text-xs">
                  <select
                    value={endType}
                    onChange={e => {
                      const v = e.target.value;
                      if (v === 'never') patch({ end: undefined });
                      else if (v === 'count') patch({ end: { count: 10 } });
                      else patch({ end: { until: format(addDays(new Date(), 30), 'yyyy-MM-dd') } });
                    }}
                    className="rounded-lg px-2 py-1.5 text-xs font-medium outline-none"
                    style={{ background: theme.surfaceBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
                  >
                    <option value="never">Never</option>
                    <option value="until">On date</option>
                    <option value="count">After count</option>
                  </select>

                  {endType === 'until' && r.end && 'until' in r.end && (
                    <input
                      type="date"
                      value={r.end.until}
                      onChange={e => patch({ end: { until: e.target.value } })}
                      className="flex-1 min-w-[120px] rounded-lg px-2 py-1.5 text-xs outline-none"
                      style={{ background: theme.surfaceBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
                    />
                  )}

                  {endType === 'count' && r.end && 'count' in r.end && (
                    <div className="flex items-center gap-1">
                      <input
                        type="number"
                        min={1}
                        max={999}
                        value={r.end.count}
                        onChange={e => patch({ end: { count: Math.max(1, parseInt(e.target.value || '1', 10)) } })}
                        className="w-14 rounded-lg px-2 py-1.5 text-xs text-center font-semibold outline-none"
                        style={{ background: theme.surfaceBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
                      />
                      <span className="text-[11px]" style={{ color: theme.menuSub }}>times</span>
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Live Summary Preview Banner */}
        {value && (
          <div
            className="flex items-center gap-2 p-2 rounded-xl text-xs font-medium border"
            style={{
              background: `${theme.accent}12`,
              borderColor: `${theme.accent}33`,
              color: theme.accent,
            }}
          >
            <Repeat size={12} className="flex-shrink-0" />
            <span className="truncate">{formatRecurrenceLabel(value, effectiveAnchor)}</span>
          </div>
        )}

        {/* Actions Footer */}
        <div className="flex items-center justify-between gap-2 pt-2 border-t" style={{ borderColor: theme.surfaceBdr }}>
          <button
            type="button"
            onClick={() => { onChange(undefined); onClose(); }}
            className="px-2.5 py-1.5 rounded-lg text-xs font-semibold hover:opacity-75 transition-opacity"
            style={{ color: theme.menuSub }}
          >
            Clear
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 rounded-lg text-xs font-bold transition-smooth hover:scale-[1.02] active:scale-95"
            style={{ background: theme.accent, color: theme.darkMode ? '#0b1220' : '#ffffff' }}
          >
            Done
          </button>
        </div>
      </motion.div>
    </>
  );
}

/**
 * One tab on the list rail.
 *
 * Doubles as a drop target: `data-list-drop` is what both the mouse handlers
 * here and the touch drag in TaskList look for, so filing a task is the same
 * gesture on a desktop and on a phone.
 */
function ListPill({
  listId, label, icon, tone, active, count, theme, editable, reorderable, beingDragged, dragDelta = 0,
  dragActive, dropActive,
  onPointerDownPill, onClick, onEdit, onDragOverList, onDragLeaveList, onDropTask,
}: {
  listId?: string;
  label: string;
  icon?: React.ReactNode;
  tone: string;
  active: boolean;
  count?: number;
  theme: TaskTheme;
  editable?: boolean;
  reorderable?: boolean;
  beingDragged?: boolean;
  dragDelta?: number;
  dragActive?: boolean;
  dropActive?: boolean;
  onPointerDownPill?: (e: React.PointerEvent<HTMLElement>) => void;
  onClick: () => void;
  onEdit?: () => void;
  onDragOverList?: () => void;
  onDragLeaveList?: () => void;
  onDropTask?: (occId: string) => void;
}) {
  return (
    <div
      data-list-drop={listId}
      data-reorder-id={reorderable ? listId : undefined}
      onPointerDown={onPointerDownPill}
      className={`flex-shrink-0 flex items-center rounded-full select-none ${reorderable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      style={{
        background: dropActive ? `${tone}30` : active ? `${tone}20` : theme.surfaceBg,
        border: `1px solid ${dropActive || active ? tone : dragActive ? `${tone}55` : theme.surfaceBdr}`,
        boxShadow: beingDragged ? `0 8px 22px rgba(0,0,0,0.4), 0 0 0 2px ${tone}` : dropActive ? `0 0 0 3px ${tone}25` : active ? `0 0 10px ${tone}22` : 'none',
        transform: beingDragged ? `translateX(${dragDelta}px) scale(1.06)` : dropActive ? 'scale(1.04)' : 'none',
        zIndex: beingDragged ? 30 : 1,
        transition: beingDragged ? 'none' : 'transform 180ms cubic-bezier(0.2, 0, 0, 1), box-shadow 180ms ease, opacity 180ms ease',
        opacity: beingDragged ? 0.95 : 1,
      }}
      onDragOver={e => {
        if (!onDropTask) return;
        // Only react to a task being dragged — never to a file or a text
        // selection dropped on the window by accident.
        if (!e.dataTransfer.types.includes('text/planner-task')) return;
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'move';
        onDragOverList?.();
      }}
      onDragLeave={e => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        onDragLeaveList?.();
      }}
      onDrop={e => {
        if (!onDropTask) return;
        const occId = e.dataTransfer.getData('text/planner-task') || e.dataTransfer.getData('text/plain');
        e.preventDefault();
        e.stopPropagation();
        if (occId) onDropTask(occId);
        else onDragLeaveList?.();
      }}
    >
      <button
        onClick={onClick}
        onContextMenu={onEdit ? e => { e.preventDefault(); onEdit(); } : undefined}
        className="flex items-center gap-1.5 pl-2.5 pr-2 py-1.5 text-[11px] font-semibold transition-smooth active:scale-95 max-w-[150px]"
        style={{ color: active || dropActive ? tone : theme.menuSub }}
        title={editable ? `${label} — right-click to edit` : label}
      >
        {icon ?? <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: tone }} />}
        <span className="truncate">{label}</span>
        {count != null && count > 0 && (
          <span
            className="tabular-nums px-1.5 rounded-full text-[10px] font-bold flex-shrink-0"
            style={{
              background: active ? tone : theme.surfaceBdr,
              color: active ? (theme.darkMode ? '#0b1220' : '#ffffff') : theme.menuSub,
            }}
          >
            {count}
          </span>
        )}
      </button>
      {onEdit && (
        <button
          data-no-drag
          onClick={e => { e.stopPropagation(); onEdit(); }}
          className="pr-2 pl-0.5 py-1.5 opacity-45 hover:opacity-100 transition-opacity"
          style={{ color: active ? tone : theme.menuSub }}
          title={`Edit “${label}”`}
        >
          <ChevronDown size={11} strokeWidth={2.6} />
        </button>
      )}
    </div>
  );
}

/**
 * Where a dragged pill would land. Zero-width when idle so the rail's spacing
 * doesn't shift the moment a drag starts.
 */
function RailInsertBar({ active, theme }: { active: boolean; theme: TaskTheme }) {
  return (
    <div className="flex-shrink-0 self-stretch flex items-center pointer-events-none" style={{ width: active ? 3 : 0 }}>
      <div
        className="w-[3px] h-full rounded-full transition-smooth duration-100"
        style={{
          background: active ? theme.accent : 'transparent',
          boxShadow: active ? `0 0 8px ${theme.accent}` : 'none',
          opacity: active ? 1 : 0,
        }}
      />
    </div>
  );
}

/**
 * The rail's inline create / edit card. Everything a list can have done to it
 * lives here so the panel never has to send you to the Settings window.
 */
function ListEditor({ list, lists, taskCount, theme, onSave, onMove, onDelete, onClose }: {
  list: TaskListDef | null;
  lists: TaskListDef[];
  taskCount: number;
  theme: TaskTheme;
  onSave: (name: string, color: string) => void;
  onMove: (dir: -1 | 1) => void;
  onDelete: (mode: ListDeleteMode) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(list?.name ?? '');
  const [color, setColor] = useState(list?.color ?? nextListColor(lists));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { nameRef.current?.focus(); nameRef.current?.select(); }, []);

  // General is structural: tasks with no list have to land somewhere, so it can
  // be recoloured and renamed but never deleted or shuffled out of first place.
  const isGeneral = list?.id === GENERAL_LIST_ID;
  const idx = list ? lists.findIndex(l => l.id === list.id) : -1;
  const canSave = !!name.trim();

  return (
    <>
      <div className="fixed inset-0 z-[60]" onMouseDown={onClose} onPointerDown={onClose} onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, y: -6, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -6, scale: 0.98 }}
        transition={{ duration: 0.13, ease: [0.16, 1, 0.3, 1] }}
        className="absolute left-2 right-2 top-full z-[61] mt-1 rounded-xl border p-2.5 shadow-xl"
        style={{
          background: theme.menuBg,
          borderColor: theme.surfaceBdr,
          boxShadow: theme.darkMode ? '0 18px 40px rgba(0,0,0,0.5)' : '0 18px 40px rgba(15,23,42,0.18)',
        }}
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: theme.menuSub }}>
            {list ? 'Edit list' : 'New list'}
          </span>
          <button onClick={onClose} className="p-0.5 rounded" style={{ color: theme.menuSub }} title="Close">
            <X size={12} />
          </button>
        </div>

        <input
          ref={nameRef}
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter' && canSave) { e.preventDefault(); onSave(name, color); }
            else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
          }}
          placeholder="List name"
          maxLength={40}
          className="w-full rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium outline-none mb-2"
          style={{ background: theme.surfaceBg, color: theme.menuText, border: `1.5px solid ${color}66` }}
        />

        <div className="flex items-center gap-1.5 flex-wrap mb-2.5">
          {TASK_LIST_COLORS.map(c => (
            <button
              key={c}
              onClick={() => setColor(c)}
              className="w-6 h-6 rounded-full transition-smooth hover:scale-110 active:scale-95 flex items-center justify-center"
              style={{ background: c, border: `2px solid ${color.toLowerCase() === c.toLowerCase() ? theme.menuText : 'transparent'}` }}
              title={c}
            >
              {color.toLowerCase() === c.toLowerCase() && (
                <Check size={11} strokeWidth={3.2} color={theme.darkMode ? '#0b1220' : '#ffffff'} />
              )}
            </button>
          ))}
        </div>

        {confirmingDelete && list ? (
          <div
            className="rounded-lg p-2 mb-2 flex flex-col gap-1.5"
            style={{ background: theme.surfaceBg, border: `1px solid ${theme.surfaceBdr}` }}
          >
            <span className="text-[11px] font-semibold" style={{ color: theme.menuText }}>
              Delete “{list.name}”{taskCount > 0 ? ` — ${taskCount} open task${taskCount === 1 ? '' : 's'}` : ''}?
            </span>
            <button
              onClick={() => onDelete('keep')}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-smooth active:scale-95"
              style={{ background: theme.hoverBg, color: theme.menuText, border: `1px solid ${theme.surfaceBdr}` }}
            >
              <CornerDownRight size={11} />
              Keep the tasks, move them to General
            </button>
            <button
              onClick={() => onDelete('purge')}
              className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-smooth active:scale-95"
              style={{ background: '#ef444418', color: theme.darkMode ? '#ff6b6b' : '#e5484d', border: '1px solid #ef444440' }}
            >
              <Trash2 size={11} />
              Delete the list and its tasks
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="w-full px-2 py-1 rounded-lg text-[11px] font-medium"
              style={{ color: theme.menuSub }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {list && (
              <>
                <IconBtn theme={theme} title="Move left" disabled={idx <= 0} onClick={() => onMove(-1)}>
                  <ArrowLeft size={12} />
                </IconBtn>
                <IconBtn theme={theme} title="Move right" disabled={idx < 0 || idx >= lists.length - 1} onClick={() => onMove(1)}>
                  <ArrowRight size={12} />
                </IconBtn>
                {!isGeneral && (
                  <IconBtn theme={theme} title="Delete list" danger onClick={() => setConfirmingDelete(true)}>
                    <Trash2 size={12} />
                  </IconBtn>
                )}
              </>
            )}
            <div className="flex-1" />
            <button
              onClick={() => canSave && onSave(name, color)}
              disabled={!canSave}
              className="px-3 py-1.5 rounded-lg text-[11.5px] font-bold transition-smooth active:scale-95 disabled:opacity-40 disabled:pointer-events-none flex items-center gap-1.5"
              style={{ background: color, color: theme.darkMode ? '#0b1220' : '#ffffff' }}
            >
              {list ? <Pencil size={11} /> : <Plus size={12} />}
              {list ? 'Save' : 'Create'}
            </button>
          </div>
        )}
      </motion.div>
    </>
  );
}

function IconBtn({ theme, title, disabled, danger, onClick, children }: {
  theme: TaskTheme; title: string; disabled?: boolean; danger?: boolean;
  onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="p-1.5 rounded-lg transition-smooth active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
      style={{
        background: theme.surfaceBg,
        border: `1px solid ${theme.surfaceBdr}`,
        color: danger ? (theme.darkMode ? '#ff6b6b' : '#e5484d') : theme.menuSub,
      }}
    >
      {children}
    </button>
  );
}

// Filter Chip Component
function FilterChip({ label, count, active, danger, theme, onClick }: {
  label: string; count?: number; active: boolean; danger?: boolean; theme: TaskTheme; onClick: () => void;
}) {
  const dangerHue = theme.darkMode ? '#ff6b6b' : '#e5484d';
  const tone = danger ? dangerHue : theme.accent;
  return (
    <button
      onClick={onClick}
      className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-smooth hover:scale-[1.02] active:scale-95"
      style={{
        background: active ? `${tone}22` : theme.surfaceBg,
        border: `1px solid ${active ? tone : theme.surfaceBdr}`,
        color: active ? tone : theme.menuSub,
        boxShadow: active ? `0 0 10px ${tone}20` : 'none',
      }}
    >
      {active && <Check size={10} strokeWidth={3} />}
      {label}
      {count != null && count > 0 && (
        <span
          className="tabular-nums px-1.5 py-0.5 rounded-full text-[10px] font-bold"
          style={{ background: active ? tone : theme.surfaceBdr, color: active ? (theme.darkMode ? '#0b1220' : '#ffffff') : theme.menuSub }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// Quick Pill Component
function QuickPill({ icon, label, title, active, disabled, theme, onClick }: {
  icon: React.ReactNode; label: string; title?: string; active: boolean; disabled?: boolean; theme: TaskTheme; onClick: () => void;
}) {
  return (
    <button
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-smooth hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
      style={{
        background: active ? `${theme.accent}22` : theme.surfaceBg,
        border: `1px solid ${active ? theme.accent : theme.surfaceBdr}`,
        color: active ? theme.accent : theme.menuSub,
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

// Section Component
function Section({ name, label, count, danger, collapsed, theme, onToggle, children }: {
  name: string; label?: string; count: number; danger?: boolean; collapsed: boolean; theme: TaskTheme;
  onToggle: () => void; children: React.ReactNode;
}) {
  const dangerHue = theme.darkMode ? '#ff6b6b' : '#e5484d';
  return (
    <div className="mb-2">
      <button
        onClick={onToggle}
        className="w-full flex items-center justify-between px-2.5 py-1.5 rounded-lg transition-colors group mb-1"
        style={{ background: `${theme.surfaceBg}55`, border: `1px solid ${theme.surfaceBdr}` }}
      >
        <div className="flex items-center gap-1.5">
          {collapsed ? <ChevronRight size={13} style={{ color: theme.menuSub }} />
                     : <ChevronDown size={13} style={{ color: theme.menuSub }} />}
          <span
            className="text-[11px] font-bold uppercase tracking-wider"
            style={{ color: danger ? dangerHue : theme.menuSub }}
          >
            {label || name}
          </span>
        </div>
        <span
          className="text-[10px] font-bold tabular-nums px-2 py-0.5 rounded-md"
          style={{ background: danger ? `${dangerHue}20` : theme.surfaceBdr, color: danger ? dangerHue : theme.menuSub }}
        >
          {count}
        </span>
      </button>

      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// Task List Component
function TaskList({
  rows, today, timeFormat, theme, taskColor, taskCheckboxShape, showDate,
  listOf, listsById, showListBadge, onListHover, onMoveToList,
  expandedParents, draggingId, dragOverId, pendingDoneIds,
  onDragStart, onDragOver, onDrop,
  onToggleExpand, onToggleDone, onOpenMenu,
}: {
  rows: Row[]; today: string; timeFormat: TimeFormat; theme: TaskTheme;
  taskColor: string; taskCheckboxShape?: 'circle' | 'square'; showDate: boolean;
  listOf: (t: Task) => string;
  listsById: Record<string, TaskListDef>;
  showListBadge: boolean;
  onListHover: (listId: string | null) => void;
  onMoveToList: (occId: string, listId: string) => void;
  expandedParents: Record<string, boolean>;
  draggingId: string | null;
  dragOverId: string | null;
  pendingDoneIds: Record<string, boolean>;
  onDragStart: (id: string | null) => void;
  onDragOver: (id: string | null) => void;
  onDrop: (sourceOccId: string, targetOccId: string, edge: InsertEdge) => void;
  onToggleExpand: (id: string) => void;
  onToggleDone: (occId: string, currentlyDone: boolean) => void;
  onOpenMenu: (occId: string, at: { x: number; y: number }) => void;
}) {
  /**
   * The list chip on a row, shown only in the All view. General is deliberately
   * unlabelled: tagging every unfiled task "General" is noise, and the absence
   * of a chip already reads as "not filed anywhere".
   */
  const badgeFor = (t: Task): TaskListDef | null => {
    if (!showListBadge) return null;
    const id = listOf(t);
    return id === GENERAL_LIST_ID ? null : listsById[id] ?? null;
  };

  const presentIds = new Set(rows.map(r => r.task.id));
  const roots = rows.filter(r => !r.task.parentId || !presentIds.has(r.task.parentId));
  // The touch drag's listeners outlive the render that created them, so the
  // "is this drop target one of mine?" test reads the rows through a ref.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const childrenOf = (id: string) => rows.filter(r => r.task.parentId === id);
  const insertTarget = (id: string, edge: InsertEdge) => `${id}:${edge}`;
  const targetFromPointer = (e: React.DragEvent<HTMLElement>, list: Row[]): { row: Row; edge: InsertEdge } | null => {
    if (!list.length) return null;
    const items = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[data-drop-row="1"]'))
      .filter(el => list.some(r => r.occId === el.dataset.occId));
    if (!items.length) return null;

    const y = e.clientY;
    let best = items[0];
    let bestDistance = Math.abs(y - (best.getBoundingClientRect().top + best.getBoundingClientRect().height / 2));

    for (const item of items.slice(1)) {
      const rect = item.getBoundingClientRect();
      const distance = Math.abs(y - (rect.top + rect.height / 2));
      if (distance < bestDistance) {
        best = item;
        bestDistance = distance;
      }
    }

    const row = list.find(r => r.occId === best.dataset.occId);
    if (!row) return null;
    const rect = best.getBoundingClientRect();
    return { row, edge: y < rect.top + rect.height / 2 ? 'before' : 'after' };
  };
  const updateNearestTarget = (e: React.DragEvent<HTMLElement>, list: Row[]) => {
    if (!draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    const target = targetFromPointer(e, list);
    if (target) onDragOver(insertTarget(target.row.occId, target.edge));
  };
  const dropAtNearestTarget = (e: React.DragEvent<HTMLElement>, list: Row[]) => {
    if (!draggingId) return;
    e.preventDefault();
    e.stopPropagation();
    const target = targetFromPointer(e, list);
    if (target && draggingId !== target.row.occId) {
      onDrop(draggingId, target.row.occId, target.edge);
    }
    onDragStart(null);
    onDragOver(null);
  };

  const getActiveGap = (list: Row[]): number | null => {
    if (!dragOverId) return null;
    const [targetOccId, edge] = dragOverId.split(':') as [string, InsertEdge];
    const idx = list.findIndex(r => r.occId === targetOccId);
    if (idx === -1) return null;
    return edge === 'after' ? idx + 1 : idx;
  };

  const activeGap = getActiveGap(roots);

  // ── Touch reordering ──────────────────────────────────────────────────────
  // HTML5 drag-and-drop simply does not exist on a touch screen: `draggable`,
  // dragstart and dataTransfer are mouse-only, so on a phone the list could not
  // be reordered at all. This is the phone equivalent, and it follows the
  // gesture people already expect from every mobile list: press and HOLD to
  // pick a row up, keep the finger down to move it, and hold near the top or
  // bottom edge to scroll the list while still holding it.
  const HOLD_MS = 380;
  const HOLD_SLOP = 10;
  const EDGE_ZONE = 64;
  const holdRef = useRef<{
    occId: string;
    x: number;
    y: number;
    timer: number;
    dragging: boolean;
  } | null>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  // The move/up listeners must be removable even though this component
  // re-renders mid-gesture (every hover target change is a state update, which
  // hands the next render brand-new handler identities). One AbortController
  // per gesture detaches all of them regardless of which render created them.
  const gestureRef = useRef<AbortController | null>(null);
  const autoScrollRef = useRef(0);
  const pointerYRef = useRef(0);
  /**
   * How far the finger has moved since it picked the row up. The row used to
   * simply fade in place and reappear somewhere else on release — there was
   * nothing under the finger to look at, and the only landing cue was a 0.5px
   * insert line that a fingertip covers completely. This is what makes the row
   * actually come with you.
   */
  const dragOriginYRef = useRef(0);
  const [dragDy, setDragDy] = useState(0);
  /** The row a FINGER is currently carrying (null for mouse/HTML5 drags). */
  const [liftedId, setLiftedId] = useState<string | null>(null);
  /** True for the tick after a touch drag, so its trailing click is ignored. */
  const justTouchDraggedRef = useRef(false);
  const suppressClick = useCallback(() => justTouchDraggedRef.current, []);

  const stopAutoScroll = useCallback(() => {
    if (autoScrollRef.current) {
      cancelAnimationFrame(autoScrollRef.current);
      autoScrollRef.current = 0;
    }
  }, []);

  const runAutoScroll = useCallback(() => {
    autoScrollRef.current = requestAnimationFrame(function step() {
      const scroller = scrollerRef.current;
      if (!scroller || !holdRef.current?.dragging) { autoScrollRef.current = 0; return; }
      const rect = scroller === document.scrollingElement
        ? { top: 0, bottom: window.innerHeight }
        : scroller.getBoundingClientRect();
      const y = pointerYRef.current;
      let dy = 0;
      // Speed ramps with how deep into the edge the finger is, so easing into
      // the zone creeps and pushing right to the edge moves fast.
      if (y < rect.top + EDGE_ZONE) {
        dy = -Math.ceil(14 * Math.min(1, (rect.top + EDGE_ZONE - y) / EDGE_ZONE));
      } else if (y > rect.bottom - EDGE_ZONE) {
        dy = Math.ceil(14 * Math.min(1, (y - (rect.bottom - EDGE_ZONE)) / EDGE_ZONE));
      }
      if (dy) scroller.scrollTop += dy;
      autoScrollRef.current = requestAnimationFrame(step);
    });
  }, []);

  /** Nearest scrollable ancestor — the tasks list, whatever it is wrapped in. */
  const findScroller = (from: HTMLElement): HTMLElement => {
    let node: HTMLElement | null = from;
    while (node) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
        return node;
      }
      node = node.parentElement;
    }
    return (document.scrollingElement as HTMLElement) || document.documentElement;
  };

  /**
   * Which list pill the finger is over, if any. Checked before rows: the rail
   * sits above the scroller, so a finger there means "file it", not "reorder".
   */
  const listUnder = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    return el?.closest<HTMLElement>('[data-list-drop]')?.dataset.listDrop || null;
  };

  /** Which row the finger is over, and which side of its middle. */
  const rowUnder = (x: number, y: number): { occId: string; edge: InsertEdge } | null => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const rowEl = el?.closest<HTMLElement>('[data-drop-row="1"]');
    const occId = rowEl?.dataset.occId;
    if (!rowEl || !occId) return null;
    const rect = rowEl.getBoundingClientRect();
    return { occId, edge: y < rect.top + rect.height / 2 ? 'before' : 'after' };
  };

  const endTouchDrag = useCallback((commit: boolean) => {
    const hold = holdRef.current;
    holdRef.current = null;
    stopAutoScroll();
    gestureRef.current?.abort();
    gestureRef.current = null;
    if (!hold) return;
    window.clearTimeout(hold.timer);
    setDragDy(0);
    setLiftedId(null);
    if (hold.dragging) {
      // A hold that ripened and was then released — moved or not — is a drag,
      // not a tap. Without this the synthetic click that follows the lift threw
      // the full-screen editor open every time you thought better of a drag.
      justTouchDraggedRef.current = true;
      window.setTimeout(() => { justTouchDraggedRef.current = false; }, 0);
      if (commit) {
        // A pill wins over a row: dropping on the rail files the task, and the
        // rail is never a place you'd mean to reorder into.
        const listId = listUnder(hold.x, pointerYRef.current);
        if (listId) {
          onMoveToList(hold.occId, listId);
        } else {
          const target = rowUnder(hold.x, pointerYRef.current);
          // Rows in ANOTHER section are not reorder targets. elementFromPoint
          // happily returns them, and the drop handler answers "not in my list"
          // by appending to the end — so a slightly long drag silently sent the
          // task to the bottom of its own section and flipped the whole panel
          // to manual sort. Ignore it instead.
          if (target && target.occId !== hold.occId && rowsRef.current.some(r => r.occId === target.occId)) {
            onDrop(hold.occId, target.occId, target.edge);
          }
        }
      }
      onListHover(null);
      onDragStart(null);
      onDragOver(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onDrop, onDragStart, onDragOver, onListHover, onMoveToList, stopAutoScroll]);

  // A non-passive touchmove that swallows the scroll. `touch-action` is only
  // read when the gesture starts, and the drag begins mid-gesture — after the
  // browser has already decided this is a scroll — so preventDefault is the
  // only thing that can stop the list sliding under the finger.
  function blockScroll(e: TouchEvent) {
    if (holdRef.current?.dragging && e.cancelable) e.preventDefault();
  }

  function onTouchMove(e: PointerEvent) {
    const hold = holdRef.current;
    if (!hold) return;
    pointerYRef.current = e.clientY;
    if (!hold.dragging) {
      // Still waiting out the hold: any real movement means the user meant to
      // scroll the list, so the pick-up is abandoned rather than fought with.
      if (Math.hypot(e.clientX - hold.x, e.clientY - hold.y) > HOLD_SLOP) {
        window.clearTimeout(hold.timer);
        endTouchDrag(false);
      }
      return;
    }
    hold.x = e.clientX;
    setDragDy(e.clientY - dragOriginYRef.current);
    const overList = listUnder(e.clientX, e.clientY);
    onListHover(overList);
    if (overList) {
      // Over the rail: no insertion line, because nothing is being reordered.
      onDragOver(null);
      return;
    }
    const target = rowUnder(e.clientX, e.clientY);
    if (target && target.occId !== hold.occId && rowsRef.current.some(r => r.occId === target.occId)) {
      onDragOver(insertTarget(target.occId, target.edge));
    } else {
      onDragOver(null);
    }
    if (!autoScrollRef.current) runAutoScroll();
  }

  function onTouchUp() { endTouchDrag(true); }
  function onTouchCancel() { endTouchDrag(false); }

  const onTouchPointerDown = (e: React.PointerEvent<HTMLElement>) => {
    if (e.pointerType === 'mouse' || e.button !== 0) return;
    const targetEl = e.target as HTMLElement;
    // Checkboxes, the overflow menu and the composer keep their plain taps.
    if (targetEl.closest('button, input, textarea, select, a, [contenteditable]')) return;
    const rowEl = targetEl.closest<HTMLElement>('[data-drop-row="1"]');
    const occId = rowEl?.dataset.occId;
    if (!rowEl || !occId) return;

    scrollerRef.current = findScroller(rowEl);
    pointerYRef.current = e.clientY;
    const timer = window.setTimeout(() => {
      const hold = holdRef.current;
      if (!hold) return;
      hold.dragging = true;
      dragOriginYRef.current = pointerYRef.current;
      setDragDy(0);
      setLiftedId(occId);
      try { navigator.vibrate?.(12); } catch { /* unsupported */ }
      onDragStart(occId);
    }, HOLD_MS);
    holdRef.current = { occId, x: e.clientX, y: e.clientY, timer, dragging: false };

    gestureRef.current?.abort();
    const gesture = new AbortController();
    gestureRef.current = gesture;
    const { signal } = gesture;
    window.addEventListener('pointermove', onTouchMove, { signal });
    window.addEventListener('pointerup', onTouchUp, { signal });
    window.addEventListener('pointercancel', onTouchCancel, { signal });
    document.addEventListener('touchmove', blockScroll, { passive: false, signal });
  };

  useEffect(() => () => { endTouchDrag(false); }, [endTouchDrag]);

  return (
    <div
      className="flex flex-col gap-0.5 min-h-[24px]"
      onPointerDown={onTouchPointerDown}
      onDragOver={e => updateNearestTarget(e, roots)}
      onDrop={e => dropAtNearestTarget(e, roots)}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDragOver(null);
      }}
    >
      <InsertLine active={activeGap === 0} theme={theme} touch={!!liftedId} />
      <>
        {roots.map((r, index) => {
          const kids = childrenOf(r.task.id);
          const expanded = expandedParents[r.task.id] ?? true;
          const kidsActiveGap = getActiveGap(kids);

          return (
            <React.Fragment key={r.occId}>
              <div data-drop-row="1" data-occ-id={r.occId}>
                <TaskRow
                  row={r}
                  today={today}
                  timeFormat={timeFormat}
                  theme={theme}
                  taskColor={taskColor}
                  taskCheckboxShape={taskCheckboxShape}
                  showDate={showDate}
                  listBadge={badgeFor(r.task)}
                  childProgress={kids.length ? `${kids.filter(k => k.done).length}/${kids.length}` : null}
                  expanded={expanded}
                  isDragging={draggingId === r.occId}
                  isDragActive={!!draggingId}
                  lifted={liftedId === r.occId}
                  dragOffset={liftedId === r.occId ? dragDy : 0}
                  suppressClick={suppressClick}
                  pendingDone={!!pendingDoneIds[r.occId]}
                  onDragStart={() => onDragStart(r.occId)}
                  onDragOver={edge => onDragOver(insertTarget(r.occId, edge))}
                  onDragEnd={() => { onDragStart(null); onDragOver(null); }}
                  onDrop={edge => {
                    if (draggingId && draggingId !== r.occId) {
                      onDrop(draggingId, r.occId, edge);
                    }
                    onDragStart(null);
                    onDragOver(null);
                  }}
                  onToggleExpand={kids.length ? () => onToggleExpand(r.task.id) : undefined}
                  onToggleDone={onToggleDone}
                  onOpenMenu={onOpenMenu}
                />
              </div>
              {expanded && kids.length > 0 && (
                <div
                  className="pl-5 border-l-2 ml-3 flex flex-col gap-0.5 my-1"
                  style={{ borderColor: `${theme.surfaceBdr}` }}
                  onDragOver={e => updateNearestTarget(e, kids)}
                  onDrop={e => dropAtNearestTarget(e, kids)}
                >
                  <InsertLine active={kidsActiveGap === 0} theme={theme} touch={!!liftedId} />
                    {kids.map((k, childIndex) => (
                      <React.Fragment key={k.occId}>
                        <div data-drop-row="1" data-occ-id={k.occId}>
                          <TaskRow
                            row={k}
                            today={today}
                            timeFormat={timeFormat}
                            theme={theme}
                            taskColor={taskColor}
                            taskCheckboxShape={taskCheckboxShape}
                            showDate={false}
                            listBadge={null}
                            childProgress={null}
                            expanded={false}
                            isDragging={draggingId === k.occId}
                            isDragActive={!!draggingId}
                            lifted={liftedId === k.occId}
                            dragOffset={liftedId === k.occId ? dragDy : 0}
                            suppressClick={suppressClick}
                            pendingDone={!!pendingDoneIds[k.occId]}
                            onDragStart={() => onDragStart(k.occId)}
                            onDragOver={edge => onDragOver(insertTarget(k.occId, edge))}
                            onDragEnd={() => { onDragStart(null); onDragOver(null); }}
                            onDrop={edge => {
                              if (draggingId && draggingId !== k.occId) {
                                onDrop(draggingId, k.occId, edge);
                              }
                              onDragStart(null);
                              onDragOver(null);
                            }}
                            onToggleDone={onToggleDone}
                            onOpenMenu={onOpenMenu}
                          />
                        </div>
                        <InsertLine active={kidsActiveGap === childIndex + 1} theme={theme} touch={!!liftedId} />
                      </React.Fragment>
                    ))}
                </div>
              )}
              <InsertLine active={activeGap === index + 1} theme={theme} touch={!!liftedId} />
            </React.Fragment>
          );
        })}
      </>
    </div>
  );
}

/**
 * Where the dragged row will land. On a mouse a hairline beside a 1px cursor is
 * plenty; under a fingertip 40-50px wide a 0.5px line in a 6px gap is invisible,
 * so on touch it grows into something you can actually see beside your thumb.
 */
function InsertLine({ active, theme, touch }: { active: boolean; theme: TaskTheme; touch?: boolean }) {
  return (
    <div className={`${touch ? 'h-3' : 'h-1.5'} flex items-center px-2 pointer-events-none`}>
      <div
        className={`${touch ? 'h-1' : 'h-0.5'} w-full rounded-full transition-smooth duration-100`}
        style={{
          background: active ? theme.accent : 'transparent',
          boxShadow: active ? `0 0 10px ${theme.accent}80` : 'none',
          transform: active ? 'scaleX(1)' : 'scaleX(0.96)',
          opacity: active ? 1 : 0,
        }}
      />
    </div>
  );
}

// Single Task Row Component
function TaskRow({
  row, today, timeFormat, theme, taskColor, taskCheckboxShape = 'circle', showDate, listBadge, childProgress, expanded,
  isDragging, isDragActive, lifted = false, dragOffset = 0, suppressClick, pendingDone, onDragStart, onDragOver, onDragEnd, onDrop,
  onToggleExpand, onToggleDone, onOpenMenu,
}: {
  row: Row; today: string; timeFormat: TimeFormat; theme: TaskTheme; taskColor: string;
  taskCheckboxShape?: 'circle' | 'square';
  showDate: boolean; listBadge: TaskListDef | null; childProgress: string | null; expanded: boolean;
  isDragging?: boolean; isDragActive?: boolean; lifted?: boolean; dragOffset?: number; suppressClick?: () => boolean; pendingDone?: boolean;
  onDragStart?: () => void; onDragOver?: (edge: InsertEdge) => void; onDragEnd?: () => void; onDrop?: (edge: InsertEdge) => void;
  onToggleExpand?: () => void;
  onToggleDone: (occId: string, currentlyDone: boolean) => void;
  onOpenMenu: (occId: string, at: { x: number; y: number }) => void;
}) {
  const vp = useViewport();
  const { task: t, done, due } = row;
  const swatch = t.color || null;
  const overdue = !done && !!due && due < today;
  const dangerHue = theme.darkMode ? '#ff6b6b' : '#e5484d';
  const isCircle = taskCheckboxShape === 'circle';
  const visualDone = done || !!pendingDone;
  const statusColor = visualDone ? theme.accent : swatch || (overdue ? dangerHue : theme.surfaceBdr);
  const rowDragStartedRef = useRef(false);
  const edgeFromEvent = (e: React.DragEvent<HTMLDivElement>): InsertEdge => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
  };

  return (
    <div
      draggable
      onDragStart={(e: any) => {
        rowDragStartedRef.current = true;
        e.stopPropagation?.();
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', row.occId);
          e.dataTransfer.setData('text/planner-task', row.occId);
        }
        onDragStart?.();
      }}
      onDragOver={(e: any) => {
        e.preventDefault?.();
        e.stopPropagation?.();
        onDragOver?.(edgeFromEvent(e));
      }}
      onDragEnd={() => {
        onDragEnd?.();
        window.setTimeout(() => { rowDragStartedRef.current = false; }, 0);
      }}
      onDrop={(e: any) => {
        e.preventDefault?.();
        e.stopPropagation?.();
        onDrop?.(edgeFromEvent(e));
      }}
      className={`group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-smooth cursor-grab active:cursor-grabbing border overflow-hidden content-auto-task ${
        lifted ? '' : isDragging ? 'opacity-30 scale-95' : isDragActive ? '' : 'hover:shadow-md hover:-translate-y-px'
      }`}
      style={{
        background: visualDone ? `${theme.accent}10` : overdue ? `${dangerHue}08` : theme.surfaceBg,
        borderColor: overdue ? `${dangerHue}40` : theme.surfaceBdr,
        boxShadow: lifted ? '0 12px 30px rgba(0,0,0,0.38)' : '0 1px 0 rgba(0,0,0,0.03)',
        contain: lifted ? undefined : 'layout paint',
        // Carried by the finger: off the page, above its neighbours, and
        // transparent to hit-testing so elementFromPoint reads what is BELOW it.
        ...(lifted ? {
          transform: `translateY(${dragOffset}px) scale(1.03)`,
          zIndex: 60,
          position: 'relative' as const,
          pointerEvents: 'none' as const,
          transition: 'none',
        } : null),
      }}
      onClick={e => {
        if (rowDragStartedRef.current || suppressClick?.()) return;
        if ((e.target as HTMLElement).closest('button')) return;
        onOpenMenu(row.occId, { x: e.clientX, y: e.clientY });
      }}
      onContextMenu={e => { e.preventDefault(); onOpenMenu(row.occId, { x: e.clientX, y: e.clientY }); }}
    >
      <span
        className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-full"
        style={{
          background: visualDone ? `${theme.accent}80`
            : overdue ? dangerHue
            : listBadge ? `${listBadge.color}99`
            : 'transparent',
        }}
      />
      <AnimatePresence>
        {pendingDone && (
          <motion.span
            key="done-sheen"
            initial={{ x: '-110%', opacity: 0 }}
            animate={{ x: '115%', opacity: [0, 0.22, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: vp.isPhone ? 0.24 : 0.38, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-y-0 left-0 w-2/3 pointer-events-none"
            style={{
              background: `linear-gradient(90deg, transparent, ${theme.accent}55, transparent)`,
            }}
          />
        )}
      </AnimatePresence>
      {/* Checkbox with generous hit target and compact spring animation */}
      <button
        onClick={e => { e.stopPropagation(); onToggleDone(row.occId, done); }}
        className="relative p-1.5 -m-1.5 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer group/chk transition-smooth touch-target"
        title={done ? 'Mark as incomplete' : 'Mark as completed'}
      >
        <AnimatePresence>
          {visualDone && !vp.isPhone && (
            <motion.span
              key="complete-burst"
              initial={{ scale: 0.3, opacity: 0.9 }}
              animate={{ scale: 1.75, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
              className={`absolute ${isCircle ? 'rounded-full' : 'rounded-md'}`}
              style={{
                width: 18,
                height: 18,
                border: `1px solid ${theme.accent}`,
                boxShadow: `0 0 14px ${theme.accent}80`,
              }}
            />
          )}
        </AnimatePresence>
        <motion.div
          whileTap={{ scale: 0.8 }}
          animate={visualDone ? { scale: [1, 1.15, 1] } : { scale: 1 }}
          transition={vp.isPhone ? { duration: 0.1 } : { type: 'spring', stiffness: 450, damping: 20 }}
          className={`relative z-10 w-4 h-4 ${isCircle ? 'rounded-full' : 'rounded'} flex items-center justify-center transition-smooth ${
            visualDone ? 'shadow-sm' : 'group-hover/chk:scale-110'
          }`}
          style={{
            border: `1.5px solid ${statusColor}`,
            background: visualDone ? theme.accent : 'transparent',
            boxShadow: visualDone ? `0 0 10px ${theme.accent}65` : 'none',
          }}
        >
          <AnimatePresence mode="wait">
            {visualDone && (
              <motion.div
                key="check-icon"
                initial={{ scale: 0, rotate: -45, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                exit={{ scale: 0, rotate: 45, opacity: 0 }}
                transition={vp.isPhone ? { duration: 0.08 } : { type: 'spring', stiffness: 500, damping: 22 }}
              >
                <Check size={10} strokeWidth={3.2} color={theme.darkMode ? '#0b1220' : '#ffffff'} />
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </button>
      {/* Title & Metadata */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-[13px] font-medium leading-snug break-words"
            style={{
              color: visualDone ? theme.menuSub : theme.menuText,
              textDecoration: visualDone ? 'line-through' : 'none',
              opacity: visualDone ? 0.68 : 1,
            }}
          >
            {t.title || 'Untitled task'}
          </span>
          {childProgress && (
            <span
              className="text-[10px] font-bold tabular-nums px-1.5 py-0.5 rounded-md"
              style={{ color: theme.menuSub, background: theme.surfaceBdr }}
            >
              {childProgress}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {listBadge && (
            <span
              className="text-[10.5px] font-semibold flex items-center gap-1 px-1.5 py-0.5 rounded-md"
              style={{ color: listBadge.color, background: `${listBadge.color}14`, border: `1px solid ${listBadge.color}33` }}
              title={`In list: ${listBadge.name}`}
            >
              <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: listBadge.color }} />
              {listBadge.name}
            </span>
          )}
          {showDate && due && (
            <span
              className="text-[10.5px] font-semibold tabular-nums flex items-center gap-1 px-1.5 py-0.5 rounded-md"
              style={{ color: overdue ? dangerHue : theme.menuSub, background: overdue ? `${dangerHue}12` : `${theme.surfaceBg}80` }}
            >
              {overdue && <AlertCircle size={10} />}
              {format(new Date(`${due}T00:00:00`), 'EEE, MMM d')}
            </span>
          )}
          {t.startTime && (
            <span className="text-[10.5px] font-medium tabular-nums flex items-center gap-1 px-1.5 py-0.5 rounded-md" style={{ color: theme.menuSub, background: `${theme.surfaceBg}80` }}>
              <Clock size={10} />
              {fmtTime(t.startTime, timeFormat)}
            </span>
          )}
          {t.recur && (
            <span className="flex items-center gap-0.5 text-[10.5px] px-1.5 py-0.5 rounded-md" style={{ color: theme.menuSub, background: `${theme.surfaceBg}80` }}>
              <Repeat size={10} />
            </span>
          )}
          {t.notes && (
            <span className="flex items-center gap-0.5 text-[10.5px] px-1.5 py-0.5 rounded-md" style={{ color: theme.menuSub, background: `${theme.surfaceBg}80` }}>
              <StickyNote size={10} />
            </span>
          )}
        </div>
      </div>

      {/* Quick Action Buttons */}
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-80 sm:opacity-50 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {onToggleExpand && (
          <button
            type="button"
            onClick={e => { e.stopPropagation(); onToggleExpand(); }}
            className="touch-target p-1 rounded-lg transition-colors flex items-center justify-center"
            style={{ color: theme.menuSub }}
            title="Toggle subtasks"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
        <button
          type="button"
          onClick={e => { e.stopPropagation(); onOpenMenu(row.occId, { x: e.clientX, y: e.clientY }); }}
          className="touch-target p-1 rounded-lg transition-colors flex items-center justify-center"
          style={{ color: theme.menuSub }}
          title="Task options"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}
