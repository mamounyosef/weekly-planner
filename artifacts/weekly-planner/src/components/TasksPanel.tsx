import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  CalendarDays, Check, ChevronDown, ChevronRight, Clock, ListTodo,
  MoreHorizontal, Plus, Repeat, StickyNote, X, Calendar, AlertCircle,
  Sparkles, Trash2, Edit3, ArrowRight, Sun, CalendarRange, Filter,
  ArrowUpDown, GripVertical, ArrowUpAZ, ArrowDownAZ, SlidersHorizontal
} from 'lucide-react';
import { addDays, format, parseISO } from 'date-fns';
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
  title: 'Title (A–Z)',
  'title-desc': 'Title (Z–A)',
};

interface TasksPanelProps {
  open: boolean;
  width: number;
  tasks: TaskData;
  filters: TaskFilter[];
  timeFormat: TimeFormat;
  weekStartsOn: WeekStartsOn;
  taskColor: string;
  theme: TaskTheme;
  onFiltersChange: (f: TaskFilter[]) => void;
  onCreate: (input: NewTaskInput) => string | null;
  onToggleDone: (occId: string) => void;
  onEdit: (occId: string, patch: Partial<Task>) => string;
  onDelete: (occId: string, mode?: DeleteMode) => void;
  onOpenMenu: (occId: string, at: { x: number; y: number }) => void;
  onResize: (w: number) => void;
  onClose: () => void;
}

const COMPLETED_COLLAPSED_KEY = 'planner-tasks-completed-collapsed';
const SORT_MODE_KEY = 'planner-tasks-sort-mode';

/** One row in the flattened list: a task plus the occurrence date it represents. */
interface Row { occId: string; task: Task; due: string | null; done: boolean }

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

export default function TasksPanel({
  open, width, tasks, filters, timeFormat, weekStartsOn, taskColor, theme,
  onFiltersChange, onCreate, onToggleDone, onEdit, onDelete, onOpenMenu, onResize, onClose,
}: TasksPanelProps) {
  const today = todayYmd();
  const tomorrow = useMemo(() => format(addDays(new Date(`${today}T00:00:00`), 1), 'yyyy-MM-dd'), [today]);
  const nextWeek = useMemo(() => format(addDays(new Date(`${today}T00:00:00`), 7), 'yyyy-MM-dd'), [today]);

  const rows = useTaskRows(tasks, today);

  const [composerTitle, setComposerTitle] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerDate, setComposerDate] = useState<string | null>(today);
  const [composerTime, setComposerTime] = useState<string | null>(null);
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

  const [completedCollapsed, setCompletedCollapsed] = useState(() => {
    try { return localStorage.getItem(COMPLETED_COLLAPSED_KEY) !== '0'; } catch { return true; }
  });

  const inputRef = useRef<HTMLInputElement>(null);
  const dateInputRef = useRef<HTMLInputElement>(null);
  const timeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    try { localStorage.setItem(COMPLETED_COLLAPSED_KEY, completedCollapsed ? '1' : '0'); } catch { /* private mode */ }
  }, [completedCollapsed]);

  useEffect(() => {
    try { localStorage.setItem(SORT_MODE_KEY, sortMode); } catch { /* private mode */ }
  }, [sortMode]);

  const resetComposer = useCallback(() => {
    setComposerTitle('');
    setComposerDate(today);
    setComposerTime(null);
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

  // Handle Drag and Drop reordering
  const handleDropTask = useCallback((sourceOccId: string, targetOccId: string, sectionList: Row[]) => {
    if (sourceOccId === targetOccId) return;

    const sourceIndex = sectionList.findIndex(r => r.occId === sourceOccId);
    const targetIndex = sectionList.findIndex(r => r.occId === targetOccId);

    if (sourceIndex === -1 || targetIndex === -1) return;

    const reordered = [...sectionList];
    const [moved] = reordered.splice(sourceIndex, 1);
    reordered.splice(targetIndex, 0, moved);

    // Apply new order index to each task in the section
    reordered.forEach((r, idx) => {
      onEdit(r.occId, { order: idx * 10 });
    });

    // Auto-switch to manual mode if not already
    if (sortMode !== 'manual') {
      setSortMode('manual');
    }
  }, [onEdit, sortMode]);

  // Resize drag handle
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleDown = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startW: width };
    const move = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      onResize(dragRef.current.startW + (dragRef.current.startX - ev.clientX));
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  const chip = theme.chip(taskColor);

  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? width : 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="flex-shrink-0 overflow-hidden relative shadow-lg"
      style={{
        borderLeft: open ? `1px solid ${theme.surfaceBdr}` : 'none',
        willChange: 'width',
      }}
      aria-hidden={!open}
    >
      <div className="h-full flex flex-col select-none" style={{ width, background: theme.menuBg }}>
        {/* Resize handle */}
        <div
          onMouseDown={onHandleDown}
          className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-30 hover:bg-sky-500/40 transition-colors"
          title="Drag to resize tasks panel"
        />

        {/* Header */}
        <div
          className="h-12 flex-shrink-0 flex items-center justify-between px-3.5 border-b"
          style={{ borderColor: theme.surfaceBdr }}
        >
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg" style={{ background: `${taskColor}18`, color: taskColor }}>
              <ListTodo size={16} />
            </div>
            <span className="text-sm font-semibold tracking-tight" style={{ color: theme.menuText }}>Tasks</span>
            {openCount > 0 && (
              <span
                className="text-[11px] font-bold px-2 py-0.5 rounded-full tabular-nums"
                style={{ background: chip.bg, color: chip.text, border: `1px solid ${chip.border}` }}
              >
                {openCount}
              </span>
            )}
          </div>

          <div className="flex items-center gap-1">
            {/* Sort Menu Button */}
            <div className="relative">
              <button
                onClick={() => setShowSortMenu(v => !v)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-semibold transition-all hover:scale-105 active:scale-95"
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
          className="flex-shrink-0 px-3 py-2 flex flex-wrap gap-1.5 border-b"
          style={{ borderColor: theme.surfaceBdr, background: theme.surfaceBg + '40' }}
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
        <div className="flex-shrink-0 px-3 py-2.5 border-b" style={{ borderColor: theme.surfaceBdr }}>
          <div
            className="flex items-center gap-2 px-3 py-2 rounded-xl transition-all shadow-sm"
            style={{
              background: theme.surfaceBg,
              border: `1.5px solid ${composerFocused ? theme.accent : theme.surfaceBdr}`,
              boxShadow: composerFocused ? `0 0 0 3px ${theme.accent}18` : 'none',
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
              placeholder="Add a new task…"
              className="flex-1 bg-transparent outline-none text-[13px] font-medium min-w-0"
              style={{ color: theme.menuText }}
            />
            {composerTitle.trim() && (
              <button
                onMouseDown={e => e.preventDefault()}
                onClick={submitComposer}
                className="px-2.5 py-1 rounded-lg text-xs font-semibold flex items-center gap-1 transition-all"
                style={{ background: theme.accent, color: theme.darkMode ? '#0b1220' : '#ffffff' }}
              >
                Add
              </button>
            )}
          </div>

          {/* Composer Schedule Bar (Date & Time Picker) */}
          <AnimatePresence initial={false}>
            {(composerFocused || composerTitle.trim() || composerDate !== today || composerTime) && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.15 }}
                className="flex flex-col gap-2 pt-2.5 overflow-hidden"
              >
                {/* Date presets row */}
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
                    label="Next Wk"
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
                    className="relative flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer transition-all hover:opacity-90"
                    style={{
                      background: (composerDate && composerDate !== today && composerDate !== tomorrow && composerDate !== nextWeek)
                        ? `${theme.accent}22` : theme.surfaceBg,
                      border: `1px solid ${(composerDate && composerDate !== today && composerDate !== tomorrow && composerDate !== nextWeek)
                        ? theme.accent : theme.surfaceBdr}`,
                      color: (composerDate && composerDate !== today && composerDate !== tomorrow && composerDate !== nextWeek)
                        ? theme.accent : theme.menuSub,
                    }}
                    onMouseDown={e => e.preventDefault()}
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

                {/* Time row */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className="text-[11px] font-semibold tracking-tight mr-1" style={{ color: theme.menuSub }}>Time:</span>
                  <QuickPill
                    icon={<Clock size={11} />}
                    label="9:00 AM"
                    active={composerTime === '09:00'}
                    disabled={!composerDate}
                    theme={theme}
                    onClick={() => setComposerTime('09:00')}
                  />
                  <QuickPill
                    icon={<Clock size={11} />}
                    label="1:00 PM"
                    active={composerTime === '13:00'}
                    disabled={!composerDate}
                    theme={theme}
                    onClick={() => setComposerTime('13:00')}
                  />
                  <QuickPill
                    icon={<Clock size={11} />}
                    label="6:00 PM"
                    active={composerTime === '18:00'}
                    disabled={!composerDate}
                    theme={theme}
                    onClick={() => setComposerTime('18:00')}
                  />

                  {/* Custom Time Picker Button */}
                  <label
                    className="relative flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium cursor-pointer transition-all hover:opacity-90"
                    style={{
                      background: composerTime ? chip.bg : theme.surfaceBg,
                      border: `1px solid ${composerTime ? chip.border : theme.surfaceBdr}`,
                      color: composerTime ? chip.text : theme.menuSub,
                      opacity: composerDate ? 1 : 0.4,
                      pointerEvents: composerDate ? 'auto' : 'none',
                    }}
                    onMouseDown={e => e.preventDefault()}
                    title="Choose custom time"
                  >
                    <Clock size={12} />
                    <span>{composerTime ? fmtTime(composerTime, timeFormat) : 'Custom Time'}</span>
                    <input
                      ref={timeInputRef}
                      type="time"
                      value={composerTime ?? ''}
                      onChange={e => setComposerTime(e.target.value || null)}
                      className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
                    />
                  </label>

                  {composerTime && (
                    <button
                      onMouseDown={e => e.preventDefault()}
                      onClick={() => setComposerTime(null)}
                      className="p-1 rounded-lg text-[11px] hover:bg-red-500/10 hover:text-red-500 transition-colors"
                      style={{ color: theme.menuSub }}
                      title="Clear time"
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Task List */}
        <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden px-2.5 py-2.5 space-y-3">
          {openCount === 0 && sections.done.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-center px-6">
              <div className="p-3 rounded-2xl" style={{ background: theme.surfaceBg, border: `1px solid ${theme.surfaceBdr}` }}>
                <Sparkles size={28} style={{ color: theme.accent }} />
              </div>
              <div>
                <h4 className="text-xs font-bold tracking-tight mb-1" style={{ color: theme.menuText }}>No tasks scheduled</h4>
                <p className="text-[11px] leading-relaxed" style={{ color: theme.menuSub }}>
                  Type a task above to schedule it for Today, Tomorrow, or any custom date.
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
                  showDate={name === 'Upcoming' || name === 'Overdue'}
                  expandedParents={expandedParents}
                  draggingId={draggingId}
                  dragOverId={dragOverId}
                  onDragStart={setDraggingId}
                  onDragOver={setDragOverId}
                  onDrop={(srcId, tgtId) => handleDropTask(srcId, tgtId, list)}
                  onToggleExpand={id => setExpandedParents(p => ({ ...p, [id]: !p[id] }))}
                  onToggleDone={onToggleDone}
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
                showDate
                expandedParents={expandedParents}
                draggingId={draggingId}
                dragOverId={dragOverId}
                onDragStart={setDraggingId}
                onDragOver={setDragOverId}
                onDrop={(srcId, tgtId) => handleDropTask(srcId, tgtId, sections.done)}
                onToggleExpand={id => setExpandedParents(p => ({ ...p, [id]: !p[id] }))}
                onToggleDone={onToggleDone}
                onOpenMenu={onOpenMenu}
              />
            </Section>
          )}
        </div>
      </div>
    </motion.aside>
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
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold transition-all hover:scale-105 active:scale-95"
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
      className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium transition-all hover:opacity-90 active:scale-95 disabled:opacity-40 disabled:pointer-events-none"
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
        className="w-full flex items-center justify-between px-2 py-1.5 rounded-lg transition-colors group mb-1"
        style={{ background: `${theme.surfaceBg}60` }}
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
  rows, today, timeFormat, theme, taskColor, showDate,
  expandedParents, draggingId, dragOverId,
  onDragStart, onDragOver, onDrop,
  onToggleExpand, onToggleDone, onOpenMenu,
}: {
  rows: Row[]; today: string; timeFormat: TimeFormat; theme: TaskTheme;
  taskColor: string; showDate: boolean;
  expandedParents: Record<string, boolean>;
  draggingId: string | null;
  dragOverId: string | null;
  onDragStart: (id: string | null) => void;
  onDragOver: (id: string | null) => void;
  onDrop: (sourceOccId: string, targetOccId: string) => void;
  onToggleExpand: (id: string) => void;
  onToggleDone: (occId: string) => void;
  onOpenMenu: (occId: string, at: { x: number; y: number }) => void;
}) {
  const presentIds = new Set(rows.map(r => r.task.id));
  const roots = rows.filter(r => !r.task.parentId || !presentIds.has(r.task.parentId));
  const childrenOf = (id: string) => rows.filter(r => r.task.parentId === id);

  return (
    <div className="flex flex-col gap-1.5">
      {roots.map(r => {
        const kids = childrenOf(r.task.id);
        const expanded = expandedParents[r.task.id] ?? true;
        return (
          <div key={r.occId} className="flex flex-col gap-1">
            <TaskRow
              row={r}
              today={today}
              timeFormat={timeFormat}
              theme={theme}
              taskColor={taskColor}
              showDate={showDate}
              childProgress={kids.length ? `${kids.filter(k => k.done).length}/${kids.length}` : null}
              expanded={expanded}
              isDragging={draggingId === r.occId}
              isDragOver={dragOverId === r.occId}
              onDragStart={() => onDragStart(r.occId)}
              onDragOver={() => onDragOver(r.occId)}
              onDragEnd={() => { onDragStart(null); onDragOver(null); }}
              onDrop={() => {
                if (draggingId && draggingId !== r.occId) {
                  onDrop(draggingId, r.occId);
                }
                onDragStart(null);
                onDragOver(null);
              }}
              onToggleExpand={kids.length ? () => onToggleExpand(r.task.id) : undefined}
              onToggleDone={onToggleDone}
              onOpenMenu={onOpenMenu}
            />
            {expanded && kids.length > 0 && (
              <div className="pl-5 border-l-2 ml-3 flex flex-col gap-1" style={{ borderColor: `${theme.surfaceBdr}` }}>
                {kids.map(k => (
                  <TaskRow
                    key={k.occId}
                    row={k}
                    today={today}
                    timeFormat={timeFormat}
                    theme={theme}
                    taskColor={taskColor}
                    showDate={false}
                    childProgress={null}
                    expanded={false}
                    isDragging={draggingId === k.occId}
                    isDragOver={dragOverId === k.occId}
                    onDragStart={() => onDragStart(k.occId)}
                    onDragOver={() => onDragOver(k.occId)}
                    onDragEnd={() => { onDragStart(null); onDragOver(null); }}
                    onDrop={() => {
                      if (draggingId && draggingId !== k.occId) {
                        onDrop(draggingId, k.occId);
                      }
                      onDragStart(null);
                      onDragOver(null);
                    }}
                    onToggleDone={onToggleDone}
                    onOpenMenu={onOpenMenu}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// Single Task Row Component
function TaskRow({
  row, today, timeFormat, theme, taskColor, showDate, childProgress, expanded,
  isDragging, isDragOver, onDragStart, onDragOver, onDragEnd, onDrop,
  onToggleExpand, onToggleDone, onOpenMenu,
}: {
  row: Row; today: string; timeFormat: TimeFormat; theme: TaskTheme; taskColor: string;
  showDate: boolean; childProgress: string | null; expanded: boolean;
  isDragging?: boolean; isDragOver?: boolean;
  onDragStart?: () => void; onDragOver?: () => void; onDragEnd?: () => void; onDrop?: () => void;
  onToggleExpand?: () => void;
  onToggleDone: (occId: string) => void;
  onOpenMenu: (occId: string, at: { x: number; y: number }) => void;
}) {
  const { task: t, done, due } = row;
  const swatch = t.color || null;
  const overdue = !done && !!due && due < today;
  const dangerHue = theme.darkMode ? '#ff6b6b' : '#e5484d';

  return (
    <div
      draggable
      onDragStart={e => {
        e.stopPropagation();
        e.dataTransfer.setData('text/plain', row.occId);
        onDragStart?.();
      }}
      onDragOver={e => {
        e.preventDefault();
        e.stopPropagation();
        onDragOver?.();
      }}
      onDragEnd={() => onDragEnd?.()}
      onDrop={e => {
        e.preventDefault();
        e.stopPropagation();
        onDrop?.();
      }}
      className={`group relative flex items-start gap-2.5 px-3 py-2 rounded-xl transition-all cursor-pointer border ${
        isDragging ? 'opacity-40 scale-95' : 'hover:shadow-md'
      }`}
      style={{
        background: done ? `${theme.surfaceBg}40` : overdue ? `${dangerHue}08` : theme.surfaceBg,
        borderColor: isDragOver ? theme.accent : overdue ? `${dangerHue}40` : theme.surfaceBdr,
        boxShadow: isDragOver ? `0 0 0 2px ${theme.accent}` : 'none',
      }}
      onClick={e => {
        if ((e.target as HTMLElement).closest('button')) return;
        onOpenMenu(row.occId, { x: e.clientX, y: e.clientY });
      }}
      onContextMenu={e => { e.preventDefault(); onOpenMenu(row.occId, { x: e.clientX, y: e.clientY }); }}
    >
      {/* Drag handle */}
      <div
        className="mt-0.5 cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-60 transition-opacity hover:opacity-100"
        style={{ color: theme.menuSub }}
        title="Drag to reorder"
      >
        <GripVertical size={14} />
      </div>

      {/* Checkbox */}
      <button
        onClick={e => { e.stopPropagation(); onToggleDone(row.occId); }}
        className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-md flex items-center justify-center transition-all hover:scale-110 active:scale-90"
        style={{
          border: `1.5px solid ${done ? theme.accent : swatch || (overdue ? dangerHue : theme.surfaceBdr)}`,
          background: done ? theme.accent : 'transparent',
          boxShadow: done ? `0 0 8px ${theme.accent}40` : 'none',
        }}
        title={done ? 'Mark as incomplete' : 'Mark as completed'}
      >
        {done && <Check size={11} strokeWidth={3} color={theme.darkMode ? '#0b1220' : '#ffffff'} />}
      </button>

      {/* Title & Metadata */}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span
            className="text-[13px] font-medium leading-snug break-words"
            style={{
              color: done ? theme.menuSub : theme.menuText,
              textDecoration: done ? 'line-through' : 'none',
              opacity: done ? 0.6 : 1,
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
              className="text-[10.5px] font-semibold tabular-nums flex items-center gap-1"
              style={{ color: overdue ? dangerHue : theme.menuSub }}
            >
              {overdue && <AlertCircle size={10} />}
              {format(new Date(`${due}T00:00:00`), 'EEE, MMM d')}
            </span>
          )}
          {t.startTime && (
            <span className="text-[10.5px] font-medium tabular-nums flex items-center gap-0.5" style={{ color: theme.menuSub }}>
              <Clock size={10} />
              {fmtTime(t.startTime, timeFormat)}
            </span>
          )}
          {t.recur && (
            <span className="flex items-center gap-0.5 text-[10.5px]" style={{ color: theme.menuSub }}>
              <Repeat size={10} />
            </span>
          )}
          {t.notes && (
            <span className="flex items-center gap-0.5 text-[10.5px]" style={{ color: theme.menuSub }}>
              <StickyNote size={10} />
            </span>
          )}
        </div>
      </div>

      {/* Quick Action Buttons */}
      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        {onToggleExpand && (
          <button
            onClick={e => { e.stopPropagation(); onToggleExpand(); }}
            className="p-1 rounded-lg hover:bg-white/10 transition-colors"
            style={{ color: theme.menuSub }}
            title="Toggle subtasks"
          >
            {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
          </button>
        )}
        <button
          onClick={e => { e.stopPropagation(); onOpenMenu(row.occId, { x: e.clientX, y: e.clientY }); }}
          className="p-1 rounded-lg hover:bg-white/10 transition-colors"
          style={{ color: theme.menuSub }}
          title="Task options"
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    </div>
  );
}
