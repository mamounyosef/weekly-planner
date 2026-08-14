import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Check, ChevronDown, ChevronRight, Clock, ListTodo,
  MoreHorizontal, Plus, Repeat, StickyNote, X, Calendar, AlertCircle,
  Sparkles, ArrowRight, Sun, CalendarRange, Filter,
  ArrowUpDown
} from 'lucide-react';
import { addDays, format } from 'date-fns';
import type { DeleteMode, WeekStartsOn } from '@/lib/recurrence';
import type { TimeFormat } from '@/lib/settingsSync';
import {
  ALL_TASK_FILTERS, TASK_FILTER_LABELS, expandTaskRange, isTaskDone,
  taskBucket, todayYmd,
  type Task, type TaskData, type TaskFilter,
} from '@/lib/tasks';

/** What the panel's composer hands back; home.tsx turns it into a real Task. */
export interface NewTaskInput {
  title: string;
  dueDate: string | null;   // 'yyyy-MM-dd', or null for a general task
  startTime?: string | null;
}

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
  timeFormat: TimeFormat;
  weekStartsOn: WeekStartsOn;
  taskColor: string;
  taskCheckboxShape?: 'circle' | 'square';
  theme: TaskTheme;
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
const LOOKAHEAD_DAYS = 60;

function useTaskRows(tasks: TaskData, today: string): Row[] {
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
      for (const { occId, occDate } of expandTaskRange(t, from, to)) {
        const done = isTaskDone(t, occDate);
        if (done && occDate < staleBefore) continue;
        rows.push({ occId, task: t.recur ? { ...t, occDate } : t, due: occDate, done });
      }
    }
    return rows;
  }, [tasks, today]);
}

function TasksPanel({
  open, width, tasks, filters, timeFormat, weekStartsOn, taskColor, taskCheckboxShape = 'circle', theme,
  onFiltersChange, onCreate, onToggleDone, onEdit, onDelete, onOpenMenu, onResize, onClose,
  sheet = false,
  page = false,
}: TasksPanelProps) {
  const today = todayYmd();
  const tomorrow = useMemo(() => format(addDays(new Date(`${today}T00:00:00`), 1), 'yyyy-MM-dd'), [today]);
  const nextWeek = useMemo(() => format(addDays(new Date(`${today}T00:00:00`), 7), 'yyyy-MM-dd'), [today]);

  const rows = useTaskRows(tasks, today);

  const [composerTitle, setComposerTitle] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerDate, setComposerDate] = useState<string | null>(today);
  const [composerTime, setComposerTime] = useState<string | null>(null);
  const [showTimePicker, setShowTimePicker] = useState(false);
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
    setShowTimePicker(false);
  }, [today]);

  const submitComposer = useCallback(() => {
    const title = composerTitle.trim();
    if (!title) return;
    onCreate({ title, dueDate: composerDate, startTime: composerDate ? composerTime : null });
    resetComposer();
    inputRef.current?.focus();
  }, [composerTitle, composerDate, composerTime, onCreate, resetComposer]);

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
    if (targetIndex !== -1) {
      reordered.splice(edge === 'after' ? targetIndex + 1 : targetIndex, 0, moved);
    } else {
      reordered.push(moved);
    }

    applyManualOrder(reordered);
  }, [applyManualOrder]);

  // Phone sheet: how far the grab handle has been pulled down, so the sheet can
  // follow the finger and spring back if the pull wasn't far enough to dismiss.
  const [sheetDragY, setSheetDragY] = useState(0);
  const [sheetDragging, setSheetDragging] = useState(false);
  const sheetStartRef = useRef<number | null>(null);
  // A sheet reopened after being dragged must start flush, never mid-pull.
  useEffect(() => { if (!open) { setSheetDragY(0); setSheetDragging(false); sheetStartRef.current = null; } }, [open]);

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
            willChange: 'opacity',
            opacity: open ? 1 : 0,
            pointerEvents: open ? 'auto' : 'none',
            transition: 'opacity 220ms ease',
          }}
        />
      )}
    <aside
      className={page
        ? 'fixed inset-x-0 top-0 z-[81] overflow-hidden'
        : sheet
        ? 'fixed inset-x-0 bottom-0 z-[81] overflow-hidden shadow-2xl'
        : 'flex-shrink-0 overflow-hidden relative shadow-lg'}
      style={page ? {
        // Its own screen, not a sheet over the calendar: no scrim to composite,
        // no slide to animate and nothing rendered underneath. Switching tabs is
        // a plain show/hide, which is the only version of this that can't drop
        // frames on a phone.
        bottom: 'var(--bottom-nav-h)',
        paddingTop: 'var(--safe-top)',
        background: theme.menuBg,
        display: open ? undefined : 'none',
      } : sheet ? {
        // Stops at the tab bar rather than sliding under it: the bar stays
        // usable (tap Calendar to get straight back) and the composer at the
        // foot of the list is never hidden behind it.
        bottom: 'var(--bottom-nav-h)',
        // Not full height — leaving the top of the calendar peeking through is
        // what makes a sheet read as "on top of" rather than "instead of", and
        // it gives the eye somewhere to tap to dismiss.
        height: 'calc(86dvh - var(--bottom-nav-h))',
        borderTopLeftRadius: 18,
        borderTopRightRadius: 18,
        borderTop: `1px solid ${theme.surfaceBdr}`,
        background: theme.menuBg,
        transform: open ? `translateY(${sheetDragY}px)` : 'translateY(110%)',
        // No transition while a finger is on the handle — the sheet has to
        // track the drag exactly, or it feels like it's on elastic.
        transition: sheetDragging ? 'none' : 'transform 300ms cubic-bezier(0.22, 1, 0.36, 1)',
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
              setSheetDragY(Math.max(0, e.clientY - sheetStartRef.current));
            }}
            onPointerUp={e => {
              if (sheetStartRef.current === null) return;
              const travelled = e.clientY - sheetStartRef.current;
              sheetStartRef.current = null;
              setSheetDragging(false);
              setSheetDragY(0);
              if (travelled > (e.currentTarget as HTMLElement).ownerDocument.defaultView!.innerHeight * 0.18) onClose();
            }}
            onPointerCancel={() => { sheetStartRef.current = null; setSheetDragging(false); setSheetDragY(0); }}
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
            <div className="p-1.5 rounded-lg flex-shrink-0" style={{ background: `${taskColor}18`, color: taskColor }}>
              <ListTodo size={16} />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm font-semibold tracking-tight truncate" style={{ color: theme.menuText }}>Tasks</span>
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
                {totalCount === 0 ? 'No tasks yet' : `${visibleCount} shown`}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Sort Menu Button */}
            <div className="relative">
              <button
                onClick={() => setShowSortMenu(v => !v)}
                className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-semibold transition-all hover:scale-[1.02] active:scale-95"
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
              className="p-1.5 rounded-lg transition-all hover:scale-105 active:scale-95"
              style={{ color: theme.menuSub }}
              onMouseEnter={e => (e.currentTarget.style.background = theme.hoverBg)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              title="Close tasks panel"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Filter chips */}
        <div
          className="flex-shrink-0 px-3 py-2 flex gap-1.5 border-b overflow-x-auto overflow-y-hidden"
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
            className="flex items-center gap-2 px-3 py-2.5 rounded-xl transition-all shadow-sm"
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
                  className="px-2.5 py-1.5 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all hover:scale-[1.02] active:scale-95"
                  style={{ background: theme.accent, color: theme.darkMode ? '#0b1220' : '#ffffff' }}
                >
                  Add
                </motion.button>
              )}
            </AnimatePresence>
          </div>

          {/* Composer Schedule Bar (Date & Time Picker) */}
          <AnimatePresence initial={false}>
            {(composerFocused || composerTitle.trim() || composerDate !== today || composerTime || showTimePicker) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="flex flex-col gap-2.5 pt-2.5 overflow-visible"
              >
                {/* Date presets row */}
                <div
                  className="rounded-xl p-2 flex flex-col gap-2"
                  style={{ background: theme.surfaceBg + '70', border: `1px solid ${theme.surfaceBdr}` }}
                >
                <div className="flex items-center gap-1.5 flex-wrap">
                  <QuickPill
                    icon={<Sun size={12} />}
                    label="Today"
                    active={composerDate === today}
                    theme={theme}
                    onClick={() => setComposerDate(today)}
                  />
                  <QuickPill
                    icon={<ArrowRight size={12} />}
                    label="Tomorrow"
                    active={composerDate === tomorrow}
                    theme={theme}
                    onClick={() => setComposerDate(tomorrow)}
                  />
                  <QuickPill
                    icon={<CalendarRange size={12} />}
                    label="Next week"
                    active={composerDate === nextWeek}
                    theme={theme}
                    onClick={() => setComposerDate(nextWeek)}
                  />
                  <QuickPill
                    icon={<X size={12} />}
                    label="No Date"
                    active={composerDate === null}
                    theme={theme}
                    onClick={() => { setComposerDate(null); setComposerTime(null); }}
                  />

                  {/* Custom Date Input Picker Button */}
                  <label
                    className="relative flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer transition-all hover:opacity-90 active:scale-95"
                    style={{
                      background: (composerDate && composerDate !== today && composerDate !== tomorrow && composerDate !== nextWeek)
                        ? `${theme.accent}22` : theme.surfaceBg,
                      border: `1px solid ${(composerDate && composerDate !== today && composerDate !== tomorrow && composerDate !== nextWeek)
                        ? theme.accent : theme.surfaceBdr}`,
                      color: (composerDate && composerDate !== today && composerDate !== tomorrow && composerDate !== nextWeek)
                        ? theme.accent : theme.menuSub,
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
                      {(composerDate && composerDate !== today && composerDate !== tomorrow && composerDate !== nextWeek)
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

                {/* Time row - clean time picker without cluttering presets */}
                <div className="flex items-center gap-1.5 flex-wrap pt-2 border-t" style={{ borderColor: theme.surfaceBdr }}>
                  <span className="text-[10.5px] font-bold uppercase tracking-wider mr-1" style={{ color: theme.menuSub }}>Time</span>
                  <div className="relative">
                    <button
                      type="button"
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => {
                        if (!composerDate) setComposerDate(today);
                        setShowTimePicker(v => !v);
                      }}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer transition-all hover:scale-[1.02] active:scale-95"
                      style={{
                        background: composerTime ? chip.bg : theme.surfaceBg,
                        border: `1px solid ${composerTime ? chip.border : theme.surfaceBdr}`,
                        color: composerTime ? chip.text : theme.menuSub,
                      }}
                      title="Set task time"
                    >
                      <Clock size={12} />
                      <span>{composerTime ? fmtTime(composerTime, timeFormat) : 'Set time'}</span>
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
                      <X size={12} />
                    </button>
                  )}
                </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Task List */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2.5 py-3 space-y-3">
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
                  {totalCount === 0 ? 'No tasks yet' : 'No tasks match'}
                </h4>
                <p className="text-[11px] leading-relaxed" style={{ color: theme.menuSub }}>
                  {totalCount === 0
                    ? 'Add one above and choose a date when needed.'
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
    <motion.div
      initial={{ opacity: 0, y: -4, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -4, scale: 0.98 }}
      transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
      className="absolute left-0 top-full mt-2 z-50 w-56 rounded-xl border p-2 shadow-xl"
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
              className="px-2 py-1.5 rounded-lg text-[11px] font-semibold transition-all hover:scale-[1.02] active:scale-95"
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
      className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[11px] font-semibold transition-all hover:scale-[1.02] active:scale-95"
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
          className="tabular-nums px-1.5 py-0.2 rounded-full text-[10px] font-bold"
          style={{ background: active ? tone : theme.surfaceBdr, color: active ? (theme.darkMode ? '#0b1220' : '#ffffff') : theme.menuSub }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

// Quick Pill Component
function QuickPill({ icon, label, active, disabled, theme, onClick }: {
  icon: React.ReactNode; label: string; active: boolean; disabled?: boolean; theme: TaskTheme; onClick: () => void;
}) {
  return (
    <button
      onMouseDown={e => e.preventDefault()}
      onClick={onClick}
      disabled={disabled}
      className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all hover:scale-[1.02] active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
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
function Section({ name, count, danger, collapsed, theme, onToggle, children }: {
  name: string; count: number; danger?: boolean; collapsed: boolean; theme: TaskTheme;
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
            {name}
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
  expandedParents, draggingId, dragOverId, pendingDoneIds,
  onDragStart, onDragOver, onDrop,
  onToggleExpand, onToggleDone, onOpenMenu,
}: {
  rows: Row[]; today: string; timeFormat: TimeFormat; theme: TaskTheme;
  taskColor: string; taskCheckboxShape?: 'circle' | 'square'; showDate: boolean;
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
  const presentIds = new Set(rows.map(r => r.task.id));
  const roots = rows.filter(r => !r.task.parentId || !presentIds.has(r.task.parentId));
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

  return (
    <div
      className="flex flex-col gap-0.5 min-h-[24px]"
      onDragOver={e => updateNearestTarget(e, roots)}
      onDrop={e => dropAtNearestTarget(e, roots)}
      onDragLeave={e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onDragOver(null);
      }}
    >
      <InsertLine active={activeGap === 0} theme={theme} />
      <AnimatePresence initial={false}>
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
                  childProgress={kids.length ? `${kids.filter(k => k.done).length}/${kids.length}` : null}
                  expanded={expanded}
                  isDragging={draggingId === r.occId}
                  isDragActive={!!draggingId}
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
                  <InsertLine active={kidsActiveGap === 0} theme={theme} />
                  <AnimatePresence initial={false}>
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
                            childProgress={null}
                            expanded={false}
                            isDragging={draggingId === k.occId}
                            isDragActive={!!draggingId}
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
                        <InsertLine active={kidsActiveGap === childIndex + 1} theme={theme} />
                      </React.Fragment>
                    ))}
                  </AnimatePresence>
                </div>
              )}
              <InsertLine active={activeGap === index + 1} theme={theme} />
            </React.Fragment>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

function InsertLine({ active, theme }: { active: boolean; theme: TaskTheme }) {
  return (
    <div className="h-1.5 flex items-center px-2 pointer-events-none">
      <div
        className="h-0.5 w-full rounded-full transition-all duration-100"
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
  row, today, timeFormat, theme, taskColor, taskCheckboxShape = 'circle', showDate, childProgress, expanded,
  isDragging, isDragActive, pendingDone, onDragStart, onDragOver, onDragEnd, onDrop,
  onToggleExpand, onToggleDone, onOpenMenu,
}: {
  row: Row; today: string; timeFormat: TimeFormat; theme: TaskTheme; taskColor: string;
  taskCheckboxShape?: 'circle' | 'square';
  showDate: boolean; childProgress: string | null; expanded: boolean;
  isDragging?: boolean; isDragActive?: boolean; pendingDone?: boolean;
  onDragStart?: () => void; onDragOver?: (edge: InsertEdge) => void; onDragEnd?: () => void; onDrop?: (edge: InsertEdge) => void;
  onToggleExpand?: () => void;
  onToggleDone: (occId: string, currentlyDone: boolean) => void;
  onOpenMenu: (occId: string, at: { x: number; y: number }) => void;
}) {
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
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: -6, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.96 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
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
      className={`group relative flex items-center gap-2.5 px-3 py-2.5 rounded-xl transition-all cursor-grab active:cursor-grabbing border overflow-hidden ${
        isDragging ? 'opacity-30 scale-95' : isDragActive ? '' : 'hover:shadow-md hover:-translate-y-px'
      }`}
      style={{
        background: visualDone ? `${theme.accent}10` : overdue ? `${dangerHue}08` : theme.surfaceBg,
        borderColor: overdue ? `${dangerHue}40` : theme.surfaceBdr,
        boxShadow: '0 1px 0 rgba(0,0,0,0.03)',
      }}
      onClick={e => {
        if (rowDragStartedRef.current) return;
        if ((e.target as HTMLElement).closest('button')) return;
        onOpenMenu(row.occId, { x: e.clientX, y: e.clientY });
      }}
      onContextMenu={e => { e.preventDefault(); onOpenMenu(row.occId, { x: e.clientX, y: e.clientY }); }}
    >
      <span
        className="absolute left-0 top-2 bottom-2 w-0.5 rounded-r-full"
        style={{ background: visualDone ? `${theme.accent}80` : overdue ? dangerHue : 'transparent' }}
      />
      <AnimatePresence>
        {pendingDone && (
          <motion.span
            key="done-sheen"
            initial={{ x: '-110%', opacity: 0 }}
            animate={{ x: '115%', opacity: [0, 0.22, 0] }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
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
        className="relative p-1.5 -m-1.5 rounded-full flex items-center justify-center flex-shrink-0 cursor-pointer group/chk transition-all"
        title={done ? 'Mark as incomplete' : 'Mark as completed'}
      >
        <AnimatePresence>
          {visualDone && (
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
          animate={visualDone ? { scale: [1, 1.22, 1] } : { scale: 1 }}
          transition={{ type: 'spring', stiffness: 450, damping: 20 }}
          className={`relative z-10 w-4 h-4 ${isCircle ? 'rounded-full' : 'rounded'} flex items-center justify-center transition-all ${
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
                transition={{ type: 'spring', stiffness: 500, damping: 22 }}
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
              className="text-[10px] font-bold tabular-nums px-1.5 py-0.2 rounded-md"
              style={{ color: theme.menuSub, background: theme.surfaceBdr }}
            >
              {childProgress}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 flex-wrap">
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
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-50 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
        {onToggleExpand && (
          <button
            onClick={e => { e.stopPropagation(); onToggleExpand(); }}
            className="p-1 rounded-lg transition-colors"
            style={{ color: theme.menuSub }}
            title="Toggle subtasks"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
        <button
          onClick={e => { e.stopPropagation(); onOpenMenu(row.occId, { x: e.clientX, y: e.clientY }); }}
          className="p-1 rounded-lg transition-colors"
          style={{ color: theme.menuSub }}
          title="Task options"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </motion.div>
  );
}
