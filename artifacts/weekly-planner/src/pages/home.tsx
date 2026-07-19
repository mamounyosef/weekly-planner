import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  format,
  addWeeks,
  subWeeks,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isToday,
} from 'date-fns';
import { ChevronLeft, ChevronRight, X, Moon, Sun, Pencil, CalendarRange, Trash2, Settings, AppWindow, CheckSquare, Undo2, Redo2, Target, BarChart3 } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  FOCUS_SESSIONS_KEY,
  FOCUS_TIMER_KEY,
  type FocusSession,
  dateKey,
  formatFocusDuration,
  getFocusTimerElapsedSeconds,
  loadLocalFocusSessions,
  loadLocalFocusTimer,
  safeFocusSessions,
  sumFocusSecondsForDay,
} from '@/lib/focusSessions';

// ─── Types ────────────────────────────────────────────────────────────────────
type IntervalMin   = 5 | 15 | 30 | 60;
type EventColor    = 'sage' | 'peach' | 'blue' | 'sand' | 'lilac';
type TimeFormat    = '12h' | '24h';
type WeekStartsOn  = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun … 6=Sat

interface PlannerEvent {
  id: string;
  dayIndex: number;
  startTime: string;
  endTime: string;
  content: string;
  color: EventColor;
  completedDates?: string[];
  noCheckbox?: boolean; // when true, this event has no completion checkbox
}

type PlannerData = Record<string, PlannerEvent>;

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY      = 'planner-v3';
const INTERVAL_KEY     = 'planner-interval';
const DARK_MODE_KEY    = 'planner-dark';
const TIME_FORMAT_KEY  = 'planner-timefmt';
const WEEK_START_KEY  = 'planner-weekstart';
const DAY_START_KEY  = 'planner-daystart';
const DAY_END_KEY    = 'planner-dayend';
const HEADER_PX      = 56;
const DRAG_THRESHOLD = 5;
const POSITION_SNAP  = 5;
const DEFAULT_EVENT_MIN = 30; // default duration for a newly created event
const COL_GAP        = 2; // px gap between parallel events

const SLOT_H: Record<IntervalMin, number> = { 5: 16, 15: 40, 30: 64, 60: 96 };

const EVENT_COLORS: Record<EventColor, { bg: string; border: string; text: string }> = {
  sage:  { bg: '#d9e8d2', border: '#7fae72', text: '#2c4726' },
  peach: { bg: '#fbe0cf', border: '#e8a274', text: '#7a3d1c' },
  blue:  { bg: '#d6e4f5', border: '#7ba6dd', text: '#1f3f66' },
  sand:  { bg: '#f2e2bd', border: '#cba25a', text: '#5c421a' },
  lilac: { bg: '#e8dcf2', border: '#b48cdb', text: '#4a2a68' },
};

const DARK_EVENT_COLORS: Record<EventColor, { bg: string; border: string; text: string }> = {
  sage:  { bg: '#182818', border: '#365e30', text: '#8ec88e' },
  peach: { bg: '#2e1810', border: '#6e3820', text: '#d48060' },
  blue:  { bg: '#101c30', border: '#284878', text: '#78aadd' },
  sand:  { bg: '#261e0e', border: '#6a4e28', text: '#c8a860' },
  lilac: { bg: '#1e1228', border: '#523070', text: '#b07ecc' },
};

const SWATCHES: EventColor[] = ['sage', 'peach', 'blue', 'sand', 'lilac'];

// ─── Utilities ─────────────────────────────────────────────────────────────────
function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minToTime(min: number): string {
  const normMin = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(normMin / 60);
  const m = normMin % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function formatTimeLabel(min: number, fmt: TimeFormat = '12h'): string {
  const normMin = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(normMin / 60);
  const m = normMin % 60;
  if (fmt === '24h') {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12}${ampm}` : `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}
function formatSlotLabel(slot: string, fmt: TimeFormat): string {
  if (fmt === '24h') return slot;
  const [hStr, mStr] = slot.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  return formatTimeLabel(h * 60 + m, fmt);
}
function snapMin(min: number, interval: IntervalMin): number {
  return Math.round(min / interval) * interval;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
function generateSlots(interval: IntervalMin, startH: number, endH: number): string[] {
  const slots: string[] = [];
  for (let h = startH; h < endH; h++) {
    const displayH = h % 24;
    for (let m = 0; m < 60; m += interval) {
      slots.push(`${String(displayH).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}
function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
function normalizeMin(min: number, dayStartH: number): number {
  if (min < dayStartH * 60) {
    return min + 24 * 60;
  }
  return min;
}
function minToY(min: number, interval: IntervalMin, dayStartH: number): number {
  const normMin = normalizeMin(min, dayStartH);
  return ((normMin - dayStartH * 60) / interval) * SLOT_H[interval];
}
function yToMin(y: number, interval: IntervalMin, dayStartH: number): number {
  return snapMin(dayStartH * 60 + (y / SLOT_H[interval]) * interval, POSITION_SNAP);
}

// ─── Parallel layout ──────────────────────────────────────────────────────────
// Returns a map of eventId → { col, numCols } for events within a single day column.
// Uses a greedy sweep to assign sub-columns, then computes numCols per event based
// on the maximum number of concurrent events during that event's span.  This way
// a lone event elsewhere in the column never gets compressed by a crowded hour.
function layoutParallel(
  evs: Array<{ id: string; startMin: number; endMin: number }>,
): Map<string, { col: number; numCols: number }> {
  const sorted = [...evs].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const colEnds: number[] = [];      // end-time of last event placed in each sub-column
  const colAssign: Record<string, number> = {};

  for (const ev of sorted) {
    let placed = false;
    for (let c = 0; c < colEnds.length; c++) {
      if (colEnds[c] <= ev.startMin) {
        colAssign[ev.id] = c;
        colEnds[c] = ev.endMin;
        placed = true;
        break;
      }
    }
    if (!placed) {
      colAssign[ev.id] = colEnds.length;
      colEnds.push(ev.endMin);
    }
  }

  // Per-event numCols: find the max concurrency within each event's time span.
  // Checking at every unique start/end boundary inside the span gives exact results.
  const result = new Map<string, { col: number; numCols: number }>();
  for (const ev of sorted) {
    const points = new Set<number>();
    points.add(ev.startMin);
    for (const other of sorted) {
      if (other.startMin > ev.startMin && other.startMin < ev.endMin) points.add(other.startMin);
      if (other.endMin   > ev.startMin && other.endMin   < ev.endMin) points.add(other.endMin);
    }

    let maxConcurrent = 1;
    for (const p of points) {
      let count = 0;
      for (const other of sorted) {
        if (other.startMin <= p && other.endMin > p) count++;
      }
      if (count > maxConcurrent) maxConcurrent = count;
    }
    result.set(ev.id, { col: colAssign[ev.id] ?? 0, numCols: maxConcurrent });
  }
  return result;
}

// ─── Main Component ────────────────────────────────────────────────────────────
export default function WeeklyPlanner() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [interval, setIntervalOpt]    = useState<IntervalMin>(5);
  const [events, setEvents]           = useState<PlannerData>({});
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [hoveredId, setHoveredId]     = useState<string | null>(null);
  const [menuId, setMenuId]           = useState<string | null>(null);
  const [menuPos, setMenuPos]         = useState<{ x: number; y: number } | null>(null);
  const [direction, setDirection]     = useState(0);
  const [darkMode, setDarkMode]       = useState(true);
  const [timeFormat, setTimeFormat]     = useState<TimeFormat>('12h');
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [selRect, setSelRect]           = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [batchDisp, setBatchDisp]       = useState<{ [id: string]: { dayIndex: number; startMin: number } } | null>(null);
  const [nowTick, setNowTick]           = useState(Date.now());
  const [dayStartH, setDayStartH]       = useState(7);
  const [dayEndH, setDayEndH]           = useState(31);
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>([]);
  const [activeFocus, setActiveFocus] = useState<{ dayKey: string; seconds: number }>({ dayKey: '', seconds: 0 });

  const dragRef = useRef<{
    eventId: string; durationMin: number; offsetMin: number;
    origDay: number; curDay: number; curStartMin: number;
    active: boolean; initX: number; initY: number;
  } | null>(null);

  const resizeRef = useRef<{
    eventId: string; edge: 'top' | 'bottom'; startMin: number; endMin: number;
  } | null>(null);

  const [dragDisp, setDragDisp]     = useState<{ id: string; day: number; startMin: number } | null>(null);
  const [resizeDisp, setResizeDisp] = useState<{ id: string; startMin: number; endMin: number } | null>(null);
  const [clipboard, setClipboard]   = useState<PlannerEvent[]>([]);

  const daysGridRef  = useRef<HTMLDivElement>(null);
  const editRef      = useRef<HTMLTextAreaElement>(null);
  const menuRef      = useRef<HTMLDivElement>(null);
  const settingsRef    = useRef<HTMLDivElement>(null);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const batchDragRef   = useRef<{
    eventIds: string[]; baseStartMins: Record<string, number>; baseDays: Record<string, number>; durations: Record<string, number>;
    origDay: number; curDay: number; baseMouseMin: number;
    active: boolean; initX: number; initY: number;
  } | null>(null);
  const batchDispRef   = useRef<{ [id: string]: { dayIndex: number; startMin: number } } | null>(null);
  const selDragRef     = useRef<{ startX: number; startY: number } | null>(null);
  const createDragRef  = useRef<{ col: number; startY: number; moved: boolean } | null>(null);
  const didDragRef     = useRef(false);
  const editingIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const menuIdRef    = useRef<string | null>(null);
  const eventsRef    = useRef<PlannerData>({});
  const dayStartRef  = useRef(7);
  const dayEndRef    = useRef(31);
  const clipboardRef = useRef<PlannerEvent[]>([]);
  const mousePosRef  = useRef<{ x: number; y: number } | null>(null);

  // ── Derived ───────────────────────────────────────────────────────────────
  const weekStart   = startOfWeek(currentDate, { weekStartsOn });
  const days        = eachDayOfInterval({ start: weekStart, end: endOfWeek(currentDate, { weekStartsOn }) });
  const slots       = generateSlots(interval, dayStartH, dayEndH);
  const sh          = SLOT_H[interval];
  const totalH      = slots.length * sh;
  const dayEndMin   = dayEndH * 60;
  const dayStartMin = dayStartH * 60;
  const colorPalette = darkMode ? DARK_EVENT_COLORS : EVENT_COLORS;

  // ── Live time indicator ────────────────────────────────────────────────────
  const nowDate = useMemo(() => new Date(nowTick), [nowTick]);
  const nowMin  = nowDate.getHours() * 60 + nowDate.getMinutes();
  const normNowMin = normalizeMin(nowMin, dayStartH);
  const nowInView = normNowMin >= dayStartMin && normNowMin <= dayEndMin;
  const todayColIdx = days.findIndex(d => isToday(d));
  const focusStats = useMemo(() => {
    const perDay = days.map(day => {
      const key = dateKey(day);
      const loggedSeconds = sumFocusSecondsForDay(focusSessions, day);
      const activeSeconds = activeFocus.dayKey === key ? activeFocus.seconds : 0;
      const sessions = focusSessions.filter(session => dateKey(session.endedAt) === key).length;
      return {
        day,
        key,
        seconds: loggedSeconds + activeSeconds,
        sessions,
      };
    });
    const weekSeconds = perDay.reduce((sum, day) => sum + day.seconds, 0);
    const sessionCount = perDay.reduce((sum, day) => sum + day.sessions, 0);
    const bestDay = perDay.reduce((best, day) => day.seconds > best.seconds ? day : best, perDay[0]);
    const maxSeconds = Math.max(1, ...perDay.map(day => day.seconds));
    return {
      perDay,
      weekSeconds,
      sessionCount,
      averageSeconds: Math.floor(weekSeconds / 7),
      bestDay,
      maxSeconds,
      todaySeconds: perDay.find(day => isToday(day.day))?.seconds ?? 0,
    };
  }, [activeFocus, days, focusSessions]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    setFocusSessions(loadLocalFocusSessions());

    const loadFocusSessions = () => {
      fetch('/api/focus-sessions')
        .then(r => r.json())
        .then(data => {
          const sessions = safeFocusSessions(data);
          setFocusSessions(sessions);
          localStorage.setItem(FOCUS_SESSIONS_KEY, JSON.stringify(sessions));
        })
        .catch(err => console.error('Failed to load focus sessions:', err));
    };

    loadFocusSessions();
    const focusPollId = setInterval(loadFocusSessions, 5000);
    return () => clearInterval(focusPollId);
  }, []);

  useEffect(() => {
    const refreshActiveFocus = () => {
      const timer = loadLocalFocusTimer();
      setActiveFocus({
        dayKey: timer.sessionStartedAt ? dateKey(timer.sessionStartedAt) : '',
        seconds: getFocusTimerElapsedSeconds(timer),
      });
    };

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === FOCUS_TIMER_KEY) refreshActiveFocus();
    };

    refreshActiveFocus();
    const activePollId = setInterval(refreshActiveFocus, 1000);
    window.addEventListener('storage', handleStorage);
    return () => {
      clearInterval(activePollId);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  // ── Persistence & Backend Sync ───────────────────────────────────────────
  const isInitialMount = useRef(true);
  const settingsLoaded = useRef(false);

  useEffect(() => {
    // Initial load from localStorage
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { try { setEvents(JSON.parse(saved)); } catch (_) {} }

    // Fetch from backend file database
    fetch('/api/events')
      .then(r => r.json())
      .then(data => {
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          setEvents(data);
        }
      })
      .catch(err => console.error('Failed to load events from backend database:', err));

    const savedInt = localStorage.getItem(INTERVAL_KEY);
    if (savedInt) setIntervalOpt(parseInt(savedInt) as IntervalMin);
    const savedDark = localStorage.getItem(DARK_MODE_KEY);
    if (savedDark === 'false') setDarkMode(false);
    const savedFmt = localStorage.getItem(TIME_FORMAT_KEY);
    if (savedFmt === '24h') setTimeFormat('24h');
    const savedWeek = localStorage.getItem(WEEK_START_KEY);
    if (savedWeek) setWeekStartsOn(parseInt(savedWeek) as WeekStartsOn);
    const savedDayStart = localStorage.getItem(DAY_START_KEY);
    if (savedDayStart) setDayStartH(parseInt(savedDayStart));
    const savedDayEnd = localStorage.getItem(DAY_END_KEY);
    if (savedDayEnd) setDayEndH(parseInt(savedDayEnd));

    // Backend is the source of truth for settings so both windows stay in sync.
    fetch('/api/settings')
      .then(r => r.json())
      .then((s) => {
        if (s && typeof s === 'object') {
          if (s.interval != null) setIntervalOpt(s.interval as IntervalMin);
          if (typeof s.darkMode === 'boolean') setDarkMode(s.darkMode);
          if (s.timeFormat) setTimeFormat(s.timeFormat as TimeFormat);
          if (s.weekStartsOn != null) setWeekStartsOn(s.weekStartsOn as WeekStartsOn);
          if (s.dayStartH != null) setDayStartH(s.dayStartH);
          if (s.dayEndH != null) setDayEndH(s.dayEndH);
        }
      })
      .catch(err => console.error('Failed to load settings from backend:', err))
      .finally(() => { settingsLoaded.current = true; });
  }, []);

  // Persist settings to the shared backend whenever any of them change (after initial load).
  useEffect(() => {
    if (!settingsLoaded.current) return;
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval, darkMode, timeFormat, weekStartsOn, dayStartH, dayEndH }),
    }).catch(err => console.error('Failed to save settings to backend:', err));
  }, [interval, darkMode, timeFormat, weekStartsOn, dayStartH, dayEndH]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));

    // Avoid overwriting backend on initial mount before fetch resolves
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
    }).catch(err => console.error('Failed to save events to backend database:', err));
  }, [events]);

  // ── Undo / Redo history ────────────────────────────────────────────────────
  const undoStack      = useRef<PlannerData[]>([]);
  const redoStack      = useRef<PlannerData[]>([]);
  const prevEventsRef  = useRef<PlannerData>({});
  const skipHistoryRef = useRef(false);
  const historyReady   = useRef(false);
  const [histVersion, setHistVersion] = useState(0);

  useEffect(() => {
    // Enable history recording only after the initial load has settled.
    const t = setTimeout(() => { historyReady.current = true; }, 0);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (prevEventsRef.current === events) return;
    if (!historyReady.current) { prevEventsRef.current = events; return; }
    if (skipHistoryRef.current) { skipHistoryRef.current = false; prevEventsRef.current = events; return; }
    undoStack.current.push(prevEventsRef.current);
    if (undoStack.current.length > 200) undoStack.current.shift();
    redoStack.current = [];
    prevEventsRef.current = events;
    setHistVersion(v => v + 1);
  }, [events]);

  const undo = useCallback(() => {
    if (!undoStack.current.length) return;
    const prevState = undoStack.current.pop()!;
    redoStack.current.push(eventsRef.current);
    skipHistoryRef.current = true;
    prevEventsRef.current = prevState;
    setEvents(prevState);
    setHistVersion(v => v + 1);
  }, []);

  const redo = useCallback(() => {
    if (!redoStack.current.length) return;
    const nextState = redoStack.current.pop()!;
    undoStack.current.push(eventsRef.current);
    skipHistoryRef.current = true;
    prevEventsRef.current = nextState;
    setEvents(nextState);
    setHistVersion(v => v + 1);
  }, []);

  const undoRef = useRef(undo); useEffect(() => { undoRef.current = undo; }, [undo]);
  const redoRef = useRef(redo); useEffect(() => { redoRef.current = redo; }, [redo]);

  // ── Backup & Restore ──────────────────────────────────────────────────────
  const exportBackup = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(events, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `weekly-planner-backup-${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const importBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (parsed && typeof parsed === 'object') {
          setEvents(parsed);
          alert('Backup imported successfully!');
        } else {
          alert('Invalid backup file structure.');
        }
      } catch (err) {
        alert('Error parsing backup file.');
      }
    };
    reader.readAsText(file);
  };

  const openWidget = () => {
    fetch('/api/launch-widget', { method: 'POST' })
      .catch(err => {
        console.error('Failed to launch native widget process:', err);
        const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
        window.open(
          window.location.origin + basePath + '/widget',
          'planner_widget',
          'width=340,height=750,menubar=no,toolbar=no,location=no,status=no,resizable=no'
        );
      });
  };
  useEffect(() => { localStorage.setItem(INTERVAL_KEY, String(interval)); }, [interval]);
  useEffect(() => { localStorage.setItem(DARK_MODE_KEY, String(darkMode)); }, [darkMode]);
  useEffect(() => { localStorage.setItem(TIME_FORMAT_KEY, timeFormat); }, [timeFormat]);
  useEffect(() => { localStorage.setItem(WEEK_START_KEY, String(weekStartsOn)); }, [weekStartsOn]);
  useEffect(() => { localStorage.setItem(DAY_START_KEY, String(dayStartH)); }, [dayStartH]);
  useEffect(() => { localStorage.setItem(DAY_END_KEY, String(dayEndH)); }, [dayEndH]);

  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);
  useEffect(() => { hoveredIdRef.current = hoveredId; }, [hoveredId]);
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { dayStartRef.current = dayStartH; }, [dayStartH]);
  useEffect(() => { dayEndRef.current = dayEndH; }, [dayEndH]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);
  useEffect(() => { menuIdRef.current = menuId; }, [menuId]);
  useEffect(() => { clipboardRef.current = clipboard; }, [clipboard]);

  // Close settings on outside click
  useEffect(() => {
    if (!settingsOpen) return;
    const handler = (e: MouseEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) {
        setSettingsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [settingsOpen]);

  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // ── Close menu on outside click / Escape ─────────────────────────────────
  useEffect(() => {
    if (!menuId) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && menuRef.current.contains(e.target as Node)) return;
      const target = e.target as HTMLElement;
      const evEl = target.closest('[data-event-id]');
      if (evEl && evEl.getAttribute('data-event-id') === menuIdRef.current) return; // clicking the item being edited keeps the popup open
      setMenuId(null);
      setMenuPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMenuId(null); setMenuPos(null); }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuId]);

  // ── Mouse coordinates tracking ───────────────────────────────────────────
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      mousePosRef.current = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', handleMouseMove);
    return () => window.removeEventListener('mousemove', handleMouseMove);
  }, []);

  const getGridCoords = useCallback((clientX: number, clientY: number) => {
    const el = daysGridRef.current;
    if (!el) return null;
    const rect     = el.getBoundingClientRect();
    const colW     = rect.width / 7;
    const dayIndex = clamp(Math.floor((clientX - rect.left) / colW), 0, 6);
    const snapped  = clamp(yToMin(Math.max(0, clientY - rect.top - HEADER_PX), interval, dayStartH), dayStartMin, dayEndMin - POSITION_SNAP);
    return { dayIndex, snappedMin: snapped };
  }, [interval, dayStartMin, dayEndMin]);

  // ── Keyboard Shortcuts (Escape, Delete/Backspace, Copy/Paste) ─────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Undo / Redo (works even while focused elsewhere, but not inside text fields)
      const inTextField = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z') && !inTextField) {
        e.preventDefault();
        if (e.shiftKey) redoRef.current(); else undoRef.current();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y') && !inTextField) {
        e.preventDefault();
        redoRef.current();
        return;
      }

      const active = document.activeElement;
      // Do not trigger shortcuts if typing inside text fields
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;

      // Escape: Clear selection & close menus
      if (e.key === 'Escape') {
        let changed = false;
        if (selectedIdsRef.current.size > 0) {
          setSelectedIds(new Set());
          changed = true;
        }
        if (menuIdRef.current) {
          setMenuId(null);
          setMenuPos(null);
          changed = true;
        }
        if (changed) {
          e.preventDefault();
        }
        return;
      }

      // Delete / Backspace: Remove selected, hovered, menu, or editing events
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const idsToDelete = new Set<string>();
        if (selectedIdsRef.current.size > 0) {
          for (const id of selectedIdsRef.current) idsToDelete.add(id);
        } else if (hoveredIdRef.current) {
          idsToDelete.add(hoveredIdRef.current);
        } else if (menuIdRef.current) {
          idsToDelete.add(menuIdRef.current);
        } else if (editingIdRef.current) {
          idsToDelete.add(editingIdRef.current);
        }

        if (idsToDelete.size > 0) {
          setEvents(prev => {
            const next = { ...prev };
            for (const id of idsToDelete) delete next[id];
            return next;
          });

          // Clean up state
          setSelectedIds(prev => {
            const next = new Set(prev);
            for (const id of idsToDelete) next.delete(id);
            return next;
          });
          if (editingIdRef.current && idsToDelete.has(editingIdRef.current)) {
            setEditingId(null);
          }
          if (menuIdRef.current && idsToDelete.has(menuIdRef.current)) {
            setMenuId(null);
            setMenuPos(null);
          }
          e.preventDefault();
        }
        return;
      }

      // Ctrl+C / Cmd+C: Copy selected, hovered, menu, or editing events
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        let targetIds: string[] = [];
        if (selectedIdsRef.current.size > 0) {
          targetIds = Array.from(selectedIdsRef.current);
        } else if (hoveredIdRef.current) {
          targetIds = [hoveredIdRef.current];
        } else if (menuIdRef.current) {
          targetIds = [menuIdRef.current];
        } else if (editingIdRef.current) {
          targetIds = [editingIdRef.current];
        }

        if (targetIds.length > 0) {
          const evsToCopy = targetIds
            .map(id => eventsRef.current[id])
            .filter((ev): ev is PlannerEvent => !!ev);
          if (evsToCopy.length > 0) {
            setClipboard(evsToCopy);
            e.preventDefault();
          }
        }
        return;
      }

      // Ctrl+V / Cmd+V: Paste events
      if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
        const clip = clipboardRef.current;
        if (!clip || clip.length === 0) return;

        let pastedAtCursor = false;
        if (mousePosRef.current) {
          const el = daysGridRef.current;
          if (el) {
            const rect = el.getBoundingClientRect();
            const { x, y } = mousePosRef.current;
            // Check if cursor is over the grid (excluding the header row)
            if (x >= rect.left && x <= rect.right && y >= rect.top + HEADER_PX && y <= rect.bottom) {
              const coords = getGridCoords(x, y);
              if (coords) {
                // Find anchor: earliest event in copied group
                let anchor = clip[0];
                let minDay = anchor.dayIndex;
                let minStart = timeToMin(anchor.startTime);

                for (const ev of clip) {
                  const start = timeToMin(ev.startTime);
                  if (ev.dayIndex < minDay || (ev.dayIndex === minDay && start < minStart)) {
                    anchor = ev;
                    minDay = ev.dayIndex;
                    minStart = start;
                  }
                }

                const newEvents: PlannerData = {};
                const pastedIds: string[] = [];

                for (const ev of clip) {
                  const newId = uid();
                  const evStart = timeToMin(ev.startTime);
                  const duration = timeToMin(ev.endTime) - evStart;

                  const dayOffset = ev.dayIndex - anchor.dayIndex;
                  const timeOffset = evStart - timeToMin(anchor.startTime);

                  const targetDay = clamp(coords.dayIndex + dayOffset, 0, 6);
                  const targetStart = clamp(
                    coords.snappedMin + timeOffset,
                    dayStartRef.current * 60,
                    dayEndRef.current * 60 - duration
                  );

                  newEvents[newId] = {
                    ...ev,
                    id: newId,
                    dayIndex: targetDay,
                    startTime: minToTime(targetStart),
                    endTime: minToTime(targetStart + duration),
                  };
                  pastedIds.push(newId);
                }

                setEvents(prev => ({ ...prev, ...newEvents }));

                if (pastedIds.length === 1) {
                  setEditingId(pastedIds[0]);
                } else {
                  setSelectedIds(new Set(pastedIds));
                }
                pastedAtCursor = true;
                e.preventDefault();
              }
            }
          }
        }

        // Fallback: paste in-place with offset (+10 min)
        if (!pastedAtCursor) {
          const newEvents: PlannerData = {};
          const pastedIds: string[] = [];

          for (const ev of clip) {
            const newId = uid();
            const evStart = timeToMin(ev.startTime);
            const duration = timeToMin(ev.endTime) - evStart;
            const pasteStart = clamp(
              evStart + 10,
              dayStartRef.current * 60,
              dayEndRef.current * 60 - duration
            );

            newEvents[newId] = {
              ...ev,
              id: newId,
              startTime: minToTime(pasteStart),
              endTime: minToTime(pasteStart + duration),
            };
            pastedIds.push(newId);
          }

          setEvents(prev => ({ ...prev, ...newEvents }));

          if (pastedIds.length === 1) {
            setEditingId(pastedIds[0]);
          } else {
            setSelectedIds(new Set(pastedIds));
          }
          e.preventDefault();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [getGridCoords]);

  // ── Global mouse move / up ────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const dr = dragRef.current;
      const rr = resizeRef.current;
      const br = batchDragRef.current;
      const sr = selDragRef.current;

      // Batch drag of multiple selected events
      if (br) {
        if (!br.active) {
          if (Math.hypot(e.clientX - br.initX, e.clientY - br.initY) >= DRAG_THRESHOLD) {
            br.active = true; didDragRef.current = true;
          } else return;
        }
        const coords = getGridCoords(e.clientX, e.clientY);
        if (!coords) return;
        br.curDay = coords.dayIndex;
        const dayDelta = coords.dayIndex - br.origDay;
        const deltaMin = clamp(snapMin(coords.snappedMin - br.baseMouseMin, POSITION_SNAP), -dayStartMin * 4, dayEndMin);
        const newBatchDisp: { [id: string]: { dayIndex: number; startMin: number } } = {};
        for (const id of br.eventIds) {
          const newStart = clamp(br.baseStartMins[id] + deltaMin, dayStartMin, dayEndMin - br.durations[id]);
          const newDay = clamp(br.baseDays[id] + dayDelta, 0, 6);
          newBatchDisp[id] = { dayIndex: newDay, startMin: newStart };
        }
        setBatchDisp(newBatchDisp);
        batchDispRef.current = newBatchDisp;
        return;
      }

      // Rubber-band selection (Ctrl+drag on empty column area)
      if (sr) {
        const rect = daysGridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top - HEADER_PX;
        const left = Math.min(sr.startX, curX);
        const top = Math.min(sr.startY, curY);
        const width = Math.abs(curX - sr.startX);
        const height = Math.abs(curY - sr.startY);
        setSelRect({ left, top, width, height });
        e.preventDefault();
        return;
      }

      // Drag-to-create on empty column area (plain left drag)
      const cr = createDragRef.current;
      if (cr) {
        const rect = daysGridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const curY = e.clientY - rect.top - HEADER_PX;
        const topPx = Math.min(cr.startY, curY);
        const heightPx = Math.abs(curY - cr.startY);
        if (heightPx >= DRAG_THRESHOLD) { cr.moved = true; didDragRef.current = true; }
        if (cr.moved) {
          const colW = rect.width / 7;
          setSelRect({ left: cr.col * colW + 4, top: topPx, width: colW - 8, height: heightPx });
        }
        e.preventDefault();
        return;
      }

      if (dr) {
        if (!dr.active) {
          if (Math.hypot(e.clientX - dr.initX, e.clientY - dr.initY) >= DRAG_THRESHOLD) {
            dr.active = true; didDragRef.current = true;
          } else return;
        }
        const coords = getGridCoords(e.clientX, e.clientY);
        if (!coords) return;
        const newStart = clamp(snapMin(coords.snappedMin - dr.offsetMin, POSITION_SNAP), dayStartMin, dayEndMin - dr.durationMin);
        dr.curDay = coords.dayIndex; dr.curStartMin = newStart;
        setDragDisp({ id: dr.eventId, day: coords.dayIndex, startMin: newStart });
      }
      if (rr) {
        const coords = getGridCoords(e.clientX, e.clientY);
        if (!coords) return;
        if (rr.edge === 'bottom') {
          const newEnd = clamp(snapMin(coords.snappedMin + POSITION_SNAP, POSITION_SNAP), rr.startMin + POSITION_SNAP, dayEndMin);
          rr.endMin = newEnd;
          setResizeDisp({ id: rr.eventId, startMin: rr.startMin, endMin: newEnd });
        } else {
          const newStart = clamp(snapMin(coords.snappedMin, POSITION_SNAP), dayStartMin, rr.endMin - POSITION_SNAP);
          rr.startMin = newStart;
          setResizeDisp({ id: rr.eventId, startMin: newStart, endMin: rr.endMin });
        }
      }
    };
    const onUp = (e: MouseEvent) => {
      const dr = dragRef.current;
      const rr = resizeRef.current;
      const br = batchDragRef.current;
      const sr = selDragRef.current;
      const cr = createDragRef.current;

      // Drag-to-create commit (plain left drag on empty area)
      if (cr) {
        createDragRef.current = null;
        setSelRect(null);
        if (cr.moved) {
          const rect = daysGridRef.current?.getBoundingClientRect();
          if (rect) {
            const curY = e.clientY - rect.top - HEADER_PX;
            let startMin = yToMin(Math.max(0, Math.min(cr.startY, curY)), interval, dayStartH);
            let endMin   = yToMin(Math.max(0, Math.max(cr.startY, curY)), interval, dayStartH);
            startMin = clamp(startMin, dayStartMin, dayEndMin - POSITION_SNAP);
            endMin   = clamp(endMin, startMin + POSITION_SNAP, dayEndMin);
            const id = uid();
            setEvents(prev => ({ ...prev, [id]: { id, dayIndex: cr.col, startTime: minToTime(startMin), endTime: minToTime(endMin), content: '', color: 'sage' } }));
            setEditingId(id);
            setMenuId(id);
            setMenuPos({ x: e.clientX + 10, y: e.clientY });
          }
          setTimeout(() => { didDragRef.current = false; }, 80);
        }
        return;
      }

      // Batch drag commit
      if (br) {
        if (br.active) {
          const finalBatch = batchDispRef.current;
          if (finalBatch) {
            setEvents(prev => {
              const next = { ...prev };
              for (const id of br.eventIds) {
                const bd = finalBatch[id];
                const ev = next[id];
                if (!ev || !bd) continue;
                const dur = br.durations[id] ?? timeToMin(ev.endTime) - timeToMin(ev.startTime);
                next[id] = { ...ev, dayIndex: bd.dayIndex, startTime: minToTime(bd.startMin), endTime: minToTime(bd.startMin + dur) };
              }
              return next;
            });
          }
          setTimeout(() => { didDragRef.current = false; }, 80);
        } else { didDragRef.current = false; }
        batchDragRef.current = null; batchDispRef.current = null; setBatchDisp(null);
        return;
      }

      // Rubber-band commit
      if (sr) {
        const gridRect = daysGridRef.current?.getBoundingClientRect();
        if (gridRect) {
          const colW = gridRect.width / 7;
          const curX = e.clientX - gridRect.left;
          const curY = e.clientY - gridRect.top - HEADER_PX;
          const left = Math.min(sr.startX, curX);
          const right = Math.max(sr.startX, curX);
          const topPx = Math.min(sr.startY, curY);
          const bottomPx = Math.max(sr.startY, curY);
          const topMin = yToMin(Math.max(0, topPx), interval, dayStartH);
          const bottomMin = yToMin(Math.max(0, bottomPx), interval, dayStartH);
          const idsToAdd: string[] = [];
          for (const [id, ev] of Object.entries(eventsRef.current)) {
            const colLeft = ev.dayIndex * colW;
            const colRight = (ev.dayIndex + 1) * colW;
            if (colRight <= left || colLeft >= right) continue;
            let evStart = normalizeMin(timeToMin(ev.startTime), dayStartH);
            let evEnd = normalizeMin(timeToMin(ev.endTime), dayStartH);
            if (evEnd <= evStart) evEnd += 1440;
            if (evStart < bottomMin && evEnd > topMin) idsToAdd.push(id);
          }
          if (idsToAdd.length) {
            setSelectedIds(prev => {
              const next = new Set(prev);
              for (const id of idsToAdd) next.add(id);
              return next;
            });
          }
        }
        selDragRef.current = null; setSelRect(null);
        return;
      }

      if (dr) {
        if (dr.active) {
          setEvents(prev => {
            const ev = prev[dr.eventId];
            if (!ev) return prev;
            return { ...prev, [dr.eventId]: { ...ev, dayIndex: dr.curDay, startTime: minToTime(dr.curStartMin), endTime: minToTime(dr.curStartMin + dr.durationMin) } };
          });
          setTimeout(() => { didDragRef.current = false; }, 80);
        } else { didDragRef.current = false; }
        dragRef.current = null; setDragDisp(null);
      }
      if (rr) {
        setEvents(prev => {
          const ev = prev[rr.eventId];
          if (!ev) return prev;
          return { ...prev, [rr.eventId]: { ...ev, startTime: minToTime(rr.startMin), endTime: minToTime(rr.endMin) } };
        });
        resizeRef.current = null; setResizeDisp(null);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [getGridCoords, interval, dayStartMin, dayEndMin]);

  // ── Event CRUD helpers ────────────────────────────────────────────────────
  const handleColClick = (e: React.MouseEvent<HTMLDivElement>, dayIdx: number) => {
    if (didDragRef.current) return;
    if ((e.target as HTMLElement).closest('[data-event]')) return;
    if (e.ctrlKey || e.metaKey) return; // Ctrl+click → rubber band handled in onMouseDown
    setSelectedIds(new Set());
    const rect     = e.currentTarget.getBoundingClientRect();
    const startMin = clamp(yToMin(Math.max(0, e.clientY - rect.top), interval, dayStartH), dayStartMin, dayEndMin - DEFAULT_EVENT_MIN);
    const dur      = Math.min(DEFAULT_EVENT_MIN, dayEndMin - startMin);
    const id       = uid();
    setEvents(prev => ({ ...prev, [id]: { id, dayIndex: dayIdx, startTime: minToTime(startMin), endTime: minToTime(startMin + dur), content: '', color: 'sage' } }));
    setEditingId(id);
    setMenuId(id);
    setMenuPos({ x: e.clientX + 10, y: e.clientY });
  };

  const handleEventMouseDown = (e: React.MouseEvent, ev: PlannerEvent) => {
    if (editingId === ev.id) return;
    e.preventDefault(); e.stopPropagation();
    if (e.ctrlKey || e.metaKey) return; // toggle selection in onClick, don't drag

    // Batch drag: mousedown on a selected event while others are selected
    if (selectedIds.size > 1 && selectedIds.has(ev.id)) {
      const coords = getGridCoords(e.clientX, e.clientY);
      if (!coords) return;
      const baseStartMins: Record<string, number> = {};
      const baseDays: Record<string, number> = {};
      const durations: Record<string, number> = {};
      for (const id of selectedIds) {
        const eRef = eventsRef.current[id];
        if (eRef) {
          const s = normalizeMin(timeToMin(eRef.startTime), dayStartH);
          let en = normalizeMin(timeToMin(eRef.endTime), dayStartH);
          if (en <= s) en += 1440;
          baseStartMins[id] = s;
          baseDays[id] = eRef.dayIndex;
          durations[id] = en - s;
        }
      }
      batchDragRef.current = {
        eventIds: [...selectedIds], baseStartMins, baseDays, durations,
        origDay: ev.dayIndex, curDay: ev.dayIndex,
        baseMouseMin: coords.snappedMin,
        active: false, initX: e.clientX, initY: e.clientY,
      };
      return;
    }

    // Single event drag
    setSelectedIds(new Set());
    const coords   = getGridCoords(e.clientX, e.clientY);
    if (!coords) return;
    const startMin = normalizeMin(timeToMin(ev.startTime), dayStartH);
    let endMin     = normalizeMin(timeToMin(ev.endTime), dayStartH);
    if (endMin <= startMin) endMin += 1440;
    const duration = endMin - startMin;
    dragRef.current = {
      eventId: ev.id, durationMin: duration,
      offsetMin: clamp(coords.snappedMin - startMin, 0, duration),
      origDay: ev.dayIndex, curDay: ev.dayIndex, curStartMin: startMin,
      active: false, initX: e.clientX, initY: e.clientY,
    };
  };

  const handleResizeMouseDown = (e: React.MouseEvent, ev: PlannerEvent, edge: 'top' | 'bottom') => {
    e.preventDefault(); e.stopPropagation();
    const startMin = normalizeMin(timeToMin(ev.startTime), dayStartH);
    let endMin     = normalizeMin(timeToMin(ev.endTime), dayStartH);
    if (endMin <= startMin) endMin += 1440;
    resizeRef.current = { eventId: ev.id, edge, startMin, endMin };
  };

  const openMenu = (e: React.MouseEvent, ev: PlannerEvent) => {
    e.stopPropagation();
    if (didDragRef.current) return;
    // Position popover to the right of the event block; fall back to left if near right edge
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x    = rect.right + 6;
    const y    = rect.top;
    setMenuId(ev.id);
    setMenuPos({ x, y });
  };

  const toggleEventCompleted = (id: string, day: Date) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    setEvents(prev => {
      const ev = prev[id];
      if (!ev) return prev;
      const completedDates = ev.completedDates || [];
      const updatedDates = completedDates.includes(dateStr)
        ? completedDates.filter(d => d !== dateStr)
        : [...completedDates, dateStr];
      const updatedEvents = { ...prev, [id]: { ...ev, completedDates: updatedDates } };
      
      fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updatedEvents),
      }).catch(err => console.error("Failed to save checkbox state:", err));
      
      return updatedEvents;
    });
  };

  const deleteEvent = (id: string) => {
    setEvents(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (editingId === id) setEditingId(null);
    setMenuId(null); setMenuPos(null);
  };

  const cloneAcrossWeek = (ev: PlannerEvent) => {
    const additions: PlannerData = {};
    for (let day = 0; day < 7; day++) {
      if (day === ev.dayIndex) continue;
      const newId = uid();
      additions[newId] = { ...ev, id: newId, dayIndex: day };
    }
    setEvents(prev => ({ ...prev, ...additions }));
    setMenuId(null); setMenuPos(null);
  };

  // ── Navigation ────────────────────────────────────────────────────────────
  const goBack  = () => { setDirection(-1); setCurrentDate(d => subWeeks(d, 1)); setEditingId(null); setMenuId(null); };
  const goNext  = () => { setDirection(1);  setCurrentDate(d => addWeeks(d, 1));  setEditingId(null); setMenuId(null); };
  const goToday = () => { setDirection(0);  setCurrentDate(new Date());            setEditingId(null); setMenuId(null); };

  // ── Display props (override during drag/resize/batch) ─────────────────────
  const normDuration = (ev: PlannerEvent) => {
    const s = normalizeMin(timeToMin(ev.startTime), dayStartH);
    let en = normalizeMin(timeToMin(ev.endTime), dayStartH);
    if (en <= s) en += 1440;
    return en - s;
  };
  const dispProps = (ev: PlannerEvent) => {
    if (batchDisp && batchDisp[ev.id]) {
      const bd = batchDisp[ev.id];
      const dur = normDuration(ev);
      return { dayIndex: bd.dayIndex, startMin: bd.startMin, endMin: bd.startMin + dur };
    }
    if (dragDisp?.id === ev.id) {
      const dur = normDuration(ev);
      return { dayIndex: dragDisp.day, startMin: dragDisp.startMin, endMin: dragDisp.startMin + dur };
    }
    if (resizeDisp?.id === ev.id) return { dayIndex: ev.dayIndex, startMin: resizeDisp.startMin, endMin: resizeDisp.endMin };
    return { dayIndex: ev.dayIndex, startMin: timeToMin(ev.startTime), endMin: timeToMin(ev.endTime) };
  };

  const isDraggingAnything = !!(dragDisp || batchDisp);
  const isResizingAnything = !!resizeDisp;
  const globalCursor = isDraggingAnything ? 'grabbing' : isResizingAnything ? 'ns-resize' : undefined;

  const surfaceBg  = darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.60)';
  const surfaceBdr = darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
  const hoverBg    = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const menuBg     = darkMode ? '#1e2022' : '#ffffff';
  const menuBdr    = darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
  const menuText   = darkMode ? '#e8e8e8' : '#1a1a1a';
  const menuSub    = darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';

  // ── Current menu event (for popover rendering) ────────────────────────────
  const menuEvent = menuId ? events[menuId] : null;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className={`min-h-screen bg-background text-foreground flex flex-col font-sans select-none${darkMode ? ' dark' : ''}`}
      style={{ cursor: globalCursor }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-background/85 backdrop-blur-md border-b border-border/50">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <span className="text-base font-semibold tracking-tight text-foreground/80">
              {format(weekStart, 'MMMM yyyy')}
            </span>
            <div className="flex items-center rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              <button onClick={goBack}  className="p-1.5 rounded-md text-muted-foreground transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}><ChevronLeft size={15}/></button>
              <button onClick={goToday} className="px-3 py-1 text-xs font-medium text-foreground/75 rounded-md transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>Today</button>
              <button onClick={goNext}  className="p-1.5 rounded-md text-muted-foreground transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}><ChevronRight size={15}/></button>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setDarkMode(d => !d)} title={darkMode ? 'Light mode' : 'Dark mode'} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              {darkMode ? <Sun size={14}/> : <Moon size={14}/>}
            </button>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Interval</span>
              <div className="flex rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                {([5, 15, 30, 60] as IntervalMin[]).map(v => (
                  <button key={v} onClick={() => setIntervalOpt(v)} className="px-3 py-1 text-xs font-medium rounded-md transition-all duration-200"
                    style={{ background: interval===v ? (darkMode?'rgba(255,255,255,0.12)':'#fff') : 'transparent', color: interval===v ? 'var(--color-foreground)' : 'var(--color-muted-foreground)', boxShadow: interval===v ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>
                    {v}m
                  </button>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-1" data-hist-version={histVersion}>
              <button
                onClick={undo}
                disabled={undoStack.current.length === 0}
                title="Undo (Ctrl+Z)"
                className="p-1.5 rounded-lg transition-colors"
                style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: 'var(--color-muted-foreground)', opacity: undoStack.current.length === 0 ? 0.4 : 1, cursor: undoStack.current.length === 0 ? 'default' : 'pointer' }}
              >
                <Undo2 size={14}/>
              </button>
              <button
                onClick={redo}
                disabled={redoStack.current.length === 0}
                title="Redo (Ctrl+Shift+Z)"
                className="p-1.5 rounded-lg transition-colors"
                style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: 'var(--color-muted-foreground)', opacity: redoStack.current.length === 0 ? 0.4 : 1, cursor: redoStack.current.length === 0 ? 'default' : 'pointer' }}
              >
                <Redo2 size={14}/>
              </button>
            </div>
            <button onClick={openWidget} title="Open Floating Widget" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              <AppWindow size={14}/>
            </button>
            <button onClick={() => setSettingsOpen(s => !s)} title="Settings" className="p-1.5 rounded-lg transition-colors" style={{ background: settingsOpen ? (darkMode?'rgba(255,255,255,0.14)':'rgba(0,0,0,0.08)') : surfaceBg, border: `1px solid ${settingsOpen ? (darkMode?'rgba(255,255,255,0.22)':surfaceBdr) : surfaceBdr}`, color: settingsOpen ? 'var(--color-foreground)' : 'var(--color-muted-foreground)' }}>
              <Settings size={14}/>
            </button>
          </div>
        </div>
      </header>

      {/* ── Grid ────────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        <div className="min-w-[900px] max-w-[1400px] mx-auto p-4">
          <section
            className="mb-4 rounded-xl border overflow-hidden"
            style={{
              background: darkMode ? 'linear-gradient(135deg, rgba(96,165,250,0.10), rgba(34,197,94,0.06))' : 'linear-gradient(135deg, rgba(59,130,246,0.08), rgba(34,197,94,0.06))',
              borderColor: surfaceBdr,
            }}
          >
            <div className="px-4 py-3 flex items-center gap-5">
              <div className="flex items-center gap-3 min-w-[240px]">
                <div className="w-9 h-9 rounded-lg flex items-center justify-center" style={{ background: darkMode ? 'rgba(96,165,250,0.16)' : 'rgba(37,99,235,0.10)', color: '#60a5fa' }}>
                  <Target size={17} />
                </div>
                <div>
                  <div className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Focus This Week</div>
                  <div className="text-xl font-semibold tabular-nums leading-tight" style={{ color: menuText }}>{formatFocusDuration(focusStats.weekSeconds)}</div>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3 min-w-[300px]">
                {[
                  ['Today', formatFocusDuration(focusStats.todaySeconds)],
                  ['Sessions', `${focusStats.sessionCount}`],
                  ['Daily Avg', formatFocusDuration(focusStats.averageSeconds)],
                ].map(([label, value]) => (
                  <div key={label} className="min-w-0">
                    <div className="text-[9px] font-bold uppercase tracking-widest truncate" style={{ color: menuSub }}>{label}</div>
                    <div className="text-sm font-semibold tabular-nums truncate" style={{ color: menuText }}>{value}</div>
                  </div>
                ))}
              </div>

              <div className="flex-1 min-w-0 flex items-end gap-2 h-16">
                {focusStats.perDay.map(day => {
                  const pct = Math.max(5, (day.seconds / focusStats.maxSeconds) * 100);
                  const active = isToday(day.day);
                  return (
                    <div key={day.key} className="flex-1 h-full flex flex-col justify-end gap-1 min-w-0">
                      <div className="flex-1 flex items-end">
                        <div
                          className="w-full rounded-t-md transition-all duration-300"
                          title={`${format(day.day, 'EEEE')}: ${formatFocusDuration(day.seconds)}`}
                          style={{
                            height: `${pct}%`,
                            background: active ? '#60a5fa' : darkMode ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)',
                            border: `1px solid ${active ? 'rgba(96,165,250,0.70)' : surfaceBdr}`,
                          }}
                        />
                      </div>
                      <div className="text-[9px] font-semibold text-center uppercase truncate" style={{ color: active ? '#60a5fa' : menuSub }}>
                        {format(day.day, 'EEE')}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="hidden xl:flex items-center gap-2 min-w-[160px] justify-end" style={{ color: menuSub }}>
                <BarChart3 size={15} />
                <span className="text-[11px] font-medium truncate">
                  Best {format(focusStats.bestDay.day, 'EEE')} - {formatFocusDuration(focusStats.bestDay.seconds)}
                </span>
              </div>
            </div>
          </section>
          <AnimatePresence initial={false} custom={direction} mode="wait">
            <motion.div
              key={weekStart.toISOString()}
              custom={direction}
              variants={{
                enter:  (d: number) => ({ x: d>0?20:d<0?-20:0, opacity: 0 }),
                center: { x: 0, opacity: 1 },
                exit:   (d: number) => ({ x: d<0?20:d>0?-20:0, opacity: 0 }),
              }}
              initial="enter" animate="center" exit="exit"
              transition={{ x: { type: 'spring', stiffness: 300, damping: 30 }, opacity: { duration: 0.15 } }}
              className="flex border border-border/60 rounded-xl overflow-hidden shadow-sm"
              style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.30)' }}
            >
              {/* Time axis */}
              <div className="flex-shrink-0 border-r border-border/50" style={{ width: 64, background: darkMode ? 'rgba(0,0,0,0.20)' : 'rgba(255,255,255,0.40)' }}>
                <div style={{ height: HEADER_PX }} className="border-b border-border/50" />
                <div className="relative" style={{ height: totalH }}>
                  {slots.map((time, i) => {
                    const isHour = time.endsWith(':00');
                    return (
                      <div key={time} className="absolute w-full flex justify-center items-start" style={{ top: i*sh, height: sh, transform: 'translateY(-50%)' }}>
                        <span className={`leading-none px-1 tabular-nums ${isHour ? 'text-[10px] font-semibold text-muted-foreground' : 'text-[8.5px] text-muted-foreground/40'}`}>
                          {formatSlotLabel(time, timeFormat)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Day columns */}
              <div ref={daysGridRef} className="flex-1 grid grid-cols-7 relative">
                {days.map((day, colIdx) => {
                  const today     = isToday(day);
                  const colEvents = Object.values(events).filter(ev => dispProps(ev).dayIndex === colIdx);

                  // Compute parallel layout for this column
                  const layoutInput = colEvents.map(ev => {
                    const dp = dispProps(ev);
                    return { id: ev.id, startMin: dp.startMin, endMin: dp.endMin };
                  });
                  const layout = layoutParallel(layoutInput);

                  return (
                    <div key={colIdx} className="flex flex-col border-r border-border/50 last:border-r-0"
                      style={{ background: today ? (darkMode ? 'rgba(100,160,100,0.04)' : 'rgba(100,160,100,0.03)') : 'transparent' }}>
                      {/* Day header */}
                      <div className={`flex-shrink-0 flex flex-col items-center justify-center border-b ${today ? 'border-primary/20' : 'border-border/50'}`} style={{ height: HEADER_PX }}>
                        <span className={`text-[9px] font-bold uppercase tracking-widest mb-0.5 ${today ? 'text-primary' : 'text-muted-foreground'}`}>{format(day, 'EEE')}</span>
                        <span className={`text-lg font-semibold leading-none ${today ? 'text-primary' : 'text-foreground/70'}`}>{format(day, 'd')}</span>
                      </div>

                      {/* Content area */}
                      <div className="relative" style={{ height: totalH, cursor: isDraggingAnything ? 'grabbing' : 'crosshair' }}
                        onClick={(e) => handleColClick(e, colIdx)}
                        onMouseDown={(e) => {
                          if ((e.target as HTMLElement).closest('[data-event]')) return;
                          if (e.button !== 0) return;
                          const rect = e.currentTarget.getBoundingClientRect();
                          const y = e.clientY - rect.top;
                          if (e.ctrlKey || e.metaKey) {
                            const gr = daysGridRef.current?.getBoundingClientRect();
                            if (gr) {
                              const sx = e.clientX - gr.left;
                              const sy = e.clientY - gr.top - HEADER_PX;
                              selDragRef.current = { startX: sx, startY: sy };
                              setSelRect({ left: sx, top: sy, width: 0, height: 0 });
                            }
                          } else {
                            // Plain left-drag on empty space → create a new event spanning the drag
                            createDragRef.current = { col: colIdx, startY: y, moved: false };
                          }
                        }}
                      >
                        {/* Grid lines */}
                        {slots.map((time, i) => (
                          <div key={time} className={`absolute w-full pointer-events-none border-b ${time.endsWith(':00') ? 'border-border/35' : 'border-border/12'}`} style={{ top: i*sh, height: sh }} />
                        ))}

                        {/* Live time indicator */}
                        {today && nowInView && colIdx === todayColIdx && (() => {
                          const lineTop = minToY(nowMin, interval, dayStartH);
                          return (
                            <div className="absolute left-0 right-0 z-30 pointer-events-none" style={{ top: lineTop, height: 0 }}>
                              {/* Circle / arrow dot */}
                              <motion.div
                                className="absolute -left-[1.5px]"
                                style={{ width: 10, height: 10, borderRadius: '50%', background: '#ef4444', top: -4 }}
                                animate={{ opacity: [0.5, 1, 0.5], scale: [0.9, 1.1, 0.9] }}
                                transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
                              />
                              {/* Thin line */}
                              <div className="absolute left-0 right-0" style={{ height: 2, background: '#ef4444', opacity: 0.65 }} />
                            </div>
                          );
                        })()}

                        {/* Events */}
                        {colEvents.map(ev => {
                          const dp       = dispProps(ev);
                          const top      = minToY(dp.startMin, interval, dayStartH);
                          const height   = Math.max(sh, minToY(dp.endMin, interval, dayStartH) - top);
                          const isDrag   = dragDisp?.id === ev.id;
                          const isEdit   = editingId === ev.id;
                          const isHov    = hoveredId === ev.id;
                          const isMenu   = menuId === ev.id;
                          const isResize = resizeDisp?.id === ev.id;
                          const isSelected = selectedIds.has(ev.id);
                          const { bg, border, text } = colorPalette[ev.color];
                          const tooShort = height < sh * 2;

                          const { col, numCols } = layout.get(ev.id) ?? { col: 0, numCols: 1 };
                          const colW   = 100 / numCols;
                          const leftPct  = col * colW;
                          const rightPct = 100 - (col + 1) * colW;
                          // Convert percent to pixel offsets accounting for gap
                          const EDGE = 3; // px from column wall
                          // left/right in %, gap between parallel events
                          const gapOffset = numCols > 1 ? COL_GAP / 2 : 0;

                          const showTopTime    = isResize && resizeRef.current?.edge === 'top';
                          const showBottomTime = isResize && resizeRef.current?.edge === 'bottom';

                          return (
                            <div
                              key={ev.id}
                              data-event="1"
                              data-event-id={ev.id}
                              className={`absolute rounded-lg border overflow-visible transition-shadow duration-150 ${isDrag ? 'shadow-2xl z-50' : isEdit||isMenu ? 'z-40 shadow-md' : 'z-10 shadow-sm hover:shadow-md'}`}
                              style={{
                                top, height,
                                left:  `calc(${leftPct}% + ${EDGE + (col > 0 ? gapOffset : 0)}px)`,
                                right: `calc(${rightPct}% + ${EDGE + (col < numCols-1 ? gapOffset : 0)}px)`,
                                backgroundColor: bg,
                                borderColor: border,
                                color: text,
                                cursor: isDrag ? 'grabbing' : isEdit ? 'text' : 'pointer',
                                opacity: isDrag ? 0.82 : 1,
                                outline: isMenu ? `2px solid ${text}` : isSelected ? `2px solid ${darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.45)'}` : 'none',
                                outlineOffset: 1,
                              }}
                              onMouseDown={(e) => handleEventMouseDown(e, ev)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (e.ctrlKey || e.metaKey) {
                                  setSelectedIds(prev => { const n = new Set(prev); if (n.has(ev.id)) n.delete(ev.id); else n.add(ev.id); return n; });
                                  return;
                                }
                                if (!didDragRef.current) openMenu(e, ev);
                              }}
                              onDoubleClick={(e) => { e.stopPropagation(); openMenu(e, ev); setEditingId(ev.id); }}
                              onMouseEnter={() => setHoveredId(ev.id)}
                              onMouseLeave={() => setHoveredId(null)}
                            >
                              {/* Top resize handle */}
                              <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center" style={{ height: 5, cursor: 'n-resize', marginTop: -1 }} onMouseDown={(e) => handleResizeMouseDown(e, ev, 'top')}>
                                <div className="rounded-full transition-opacity duration-150" style={{ width: 24, height: 2, backgroundColor: text, opacity: isHov||isEdit||isMenu ? 0.35 : 0, pointerEvents: 'none' }} />
                              </div>

                              {/* Top time tooltip */}
                              {showTopTime && resizeDisp && (
                                <div className="absolute z-50 pointer-events-none" style={{ top: -22, left: '50%', transform: 'translateX(-50%)' }}>
                                  <div className="text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style={{ background: text, color: bg, boxShadow: '0 1px 4px rgba(0,0,0,0.25)' }}>
                                    {formatTimeLabel(resizeDisp.startMin, timeFormat)}
                                  </div>
                                </div>
                              )}

                              {/* Content */}
                              <div className="absolute inset-0 px-2 pt-2 pb-2 flex flex-col overflow-hidden" style={{ top: 4, bottom: 6 }}>
                                {isEdit ? (
                                  <>
                                    <textarea
                                      ref={editRef}
                                      value={ev.content}
                                      onChange={e => setEvents(prev => ({ ...prev, [ev.id]: { ...prev[ev.id], content: e.target.value } }))}
                                      onKeyDown={e => {
                                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); setEditingId(null); }
                                        if (e.key === 'Escape') setEditingId(null);
                                      }}
                                      onBlur={() => setEditingId(null)}
                                      onClick={e => e.stopPropagation()}
                                      className="flex-1 w-full resize-none bg-transparent outline-none text-xs leading-snug placeholder:opacity-40"
                                      style={{ color: text, minHeight: 0 }}
                                      placeholder="What's happening?"
                                    />
                                    {!tooShort && (
                                      <div className="flex items-center gap-1 pt-1 flex-shrink-0" onMouseDown={e => e.preventDefault()}>
                                        {SWATCHES.map(c => {
                                          const sc = colorPalette[c];
                                          return (
                                            <button key={c} type="button"
                                              onClick={e => { e.stopPropagation(); setEvents(prev => ({ ...prev, [ev.id]: { ...prev[ev.id], color: c } })); }}
                                              className="rounded-full border transition-transform hover:scale-110"
                                              style={{ width: 11, height: 11, backgroundColor: sc.bg, borderColor: sc.border, outline: ev.color===c ? `2px solid ${sc.text}` : 'none', outlineOffset: 1 }}
                                            />
                                          );
                                        })}
                                      </div>
                                    )}
                                  </>
                                ) : (() => {
                                  const dateStr = format(day, 'yyyy-MM-dd');
                                  const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(dateStr) ?? false);
                                  return (
                                    <>
                                      <div className="flex items-start gap-1.5 flex-1 min-h-0">
                                        {today && !ev.noCheckbox && (
                                          <button
                                            type="button"
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              toggleEventCompleted(ev.id, day);
                                            }}
                                            className="flex-shrink-0 mt-0.5 w-3.5 h-3.5 rounded-full border transition-all duration-150 flex items-center justify-center cursor-pointer"
                                            style={{
                                              borderColor: isCompleted ? text : `${text}50`,
                                              backgroundColor: isCompleted ? text : 'transparent',
                                            }}
                                          >
                                            {isCompleted && (
                                              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: bg }} />
                                            )}
                                          </button>
                                        )}
                                        <p className={`text-xs font-medium leading-snug break-words line-clamp-5 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                                          {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                                        </p>
                                      </div>
                                      {!tooShort && (
                                        <span className="text-[8.5px] font-medium tabular-nums flex-shrink-0 mt-auto" style={{ color: text, opacity: 0.45 }}>
                                          {formatTimeLabel(dp.startMin, timeFormat)} – {formatTimeLabel(dp.endMin, timeFormat)}
                                        </span>
                                      )}
                                    </>
                                  );
                                })()}
                              </div>

                              {/* Bottom resize handle */}
                              <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center" style={{ height: 5, cursor: 's-resize', marginBottom: -1 }} onMouseDown={(e) => handleResizeMouseDown(e, ev, 'bottom')}>
                                <div className="rounded-full transition-opacity duration-150" style={{ width: 24, height: 2, backgroundColor: text, opacity: isHov||isEdit||isMenu ? 0.35 : 0, pointerEvents: 'none' }} />
                              </div>

                              {/* Bottom time tooltip */}
                              {showBottomTime && resizeDisp && (
                                <div className="absolute z-50 pointer-events-none" style={{ bottom: -22, left: '50%', transform: 'translateX(-50%)' }}>
                                  <div className="text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style={{ background: text, color: bg, boxShadow: '0 1px 4px rgba(0,0,0,0.25)' }}>
                                    {formatTimeLabel(resizeDisp.endMin, timeFormat)}
                                  </div>
                                </div>
                              )}

                              {/* Move handle */}
                              <div
                                className="absolute z-40 transition-all duration-150"
                                style={{ width: 18, height: 18, bottom: -9, right: -9, borderRadius: 3, backgroundColor: bg, border: `1.5px solid ${border}`, boxShadow: '0 1px 4px rgba(0,0,0,0.18)', cursor: 'grab', opacity: isHov||isEdit||isMenu ? 1 : 0, pointerEvents: isHov||isEdit||isMenu ? 'auto' : 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                onMouseDown={(e) => { e.stopPropagation(); didDragRef.current = true; handleEventMouseDown(e as unknown as React.MouseEvent, ev); }}
                                onClick={(e) => { e.stopPropagation(); e.preventDefault(); }}
                              >
                                <svg width="6" height="6" viewBox="0 0 6 6" fill={text} style={{ opacity: 0.5 }}>
                                  <circle cx="1.5" cy="1.5" r="1"/><circle cx="4.5" cy="1.5" r="1"/>
                                  <circle cx="1.5" cy="4.5" r="1"/><circle cx="4.5" cy="4.5" r="1"/>
                                </svg>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* Selection rectangle overlay (spans multiple days) */}
                {selRect && (
                  <div className="absolute pointer-events-none z-20" style={{
                    left: selRect.left,
                    top: HEADER_PX + selRect.top,
                    width: Math.max(2, selRect.width),
                    height: Math.max(2, selRect.height),
                    background: darkMode ? 'rgba(120,180,240,0.18)' : 'rgba(60,120,200,0.13)',
                    border: `1.5px solid ${darkMode ? 'rgba(120,180,240,0.40)' : 'rgba(60,120,200,0.30)'}`,
                    borderRadius: 6,
                  }} />
                )}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>

      {/* ── Settings drawer ─────────────────────────────────────────────── */}
      <AnimatePresence>
        {settingsOpen && (
          <motion.div
            ref={settingsRef}
            key="settings-drawer"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', stiffness: 340, damping: 32 }}
            className="fixed top-14 right-0 bottom-0 z-[150] flex flex-col overflow-y-auto"
            style={{
              width: 280,
              background: darkMode ? '#16181a' : '#f9f9f9',
              borderLeft: `1px solid ${surfaceBdr}`,
              boxShadow: darkMode ? '-8px 0 32px rgba(0,0,0,0.45)' : '-8px 0 32px rgba(0,0,0,0.10)',
            }}
            onMouseDown={e => e.stopPropagation()}
          >
            {/* Drawer header */}
            <div className="flex items-center justify-between px-4 py-3.5" style={{ borderBottom: `1px solid ${surfaceBdr}` }}>
              <span className="text-sm font-semibold" style={{ color: menuText }}>Settings</span>
              <button onClick={() => setSettingsOpen(false)} className="p-1 rounded-md text-muted-foreground hover:text-foreground transition-colors">
                <X size={14}/>
              </button>
            </div>

            <div className="flex flex-col gap-6 px-4 py-5">

              {/* Time format */}
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Time Format</span>
                <div className="flex rounded-lg p-0.5" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                  {(['12h', '24h'] as TimeFormat[]).map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => setTimeFormat(fmt)}
                      className="flex-1 py-1.5 text-xs font-medium rounded-md transition-all duration-200"
                      style={{
                        background: timeFormat === fmt ? (darkMode ? 'rgba(255,255,255,0.13)' : '#fff') : 'transparent',
                        color: timeFormat === fmt ? menuText : menuSub,
                        boxShadow: timeFormat === fmt ? '0 1px 3px rgba(0,0,0,0.15)' : 'none',
                      }}
                    >
                      {fmt === '12h' ? '12h (AM/PM)' : '24h'}
                    </button>
                  ))}
                </div>
                <p className="text-[10px] leading-relaxed" style={{ color: menuSub }}>
                  {timeFormat === '12h' ? 'e.g. 9am, 2:30pm' : 'e.g. 09:00, 14:30'}
                </p>
              </div>

              {/* Appearance */}
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Appearance</span>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium" style={{ color: menuText }}>Dark mode</span>
                  <button
                    onClick={() => setDarkMode(d => !d)}
                    className="relative flex-shrink-0 rounded-full transition-colors duration-200"
                    style={{
                      width: 36, height: 20,
                      background: darkMode ? 'rgba(120,200,120,0.55)' : surfaceBdr,
                      border: `1px solid ${surfaceBdr}`,
                    }}
                  >
                    <span
                      className="absolute rounded-full transition-transform duration-200"
                      style={{
                        width: 15, height: 15, top: 2, left: 2,
                        background: darkMode ? '#fff' : menuSub,
                        transform: darkMode ? 'translateX(17px)' : 'translateX(0px)',
                      }}
                    />
                  </button>
                </div>
              </div>

              {/* Grid interval */}
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Grid Interval</span>
                <div className="flex rounded-lg p-0.5" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                  {([5, 15, 30, 60] as IntervalMin[]).map(v => (
                    <button
                      key={v}
                      onClick={() => setIntervalOpt(v)}
                      className="flex-1 py-1.5 text-xs font-medium rounded-md transition-all duration-200"
                      style={{
                        background: interval === v ? (darkMode ? 'rgba(255,255,255,0.13)' : '#fff') : 'transparent',
                        color: interval === v ? menuText : menuSub,
                        boxShadow: interval === v ? '0 1px 3px rgba(0,0,0,0.15)' : 'none',
                      }}
                    >
                      {v}m
                    </button>
                  ))}
                </div>
              </div>

              {/* Week starts on */}
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Week Starts On</span>
                <div className="flex rounded-lg p-0.5 flex-wrap" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                  {([
                    [0, 'Sun'], [1, 'Mon'], [2, 'Tue'], [3, 'Wed'],
                    [4, 'Thu'], [5, 'Fri'], [6, 'Sat'],
                  ] as [WeekStartsOn, string][]).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setWeekStartsOn(v)}
                      className="flex-1 py-1.5 text-xs font-medium rounded-md transition-all duration-200"
                      style={{
                        background: weekStartsOn === v ? (darkMode ? 'rgba(255,255,255,0.13)' : '#fff') : 'transparent',
                        color: weekStartsOn === v ? menuText : menuSub,
                        boxShadow: weekStartsOn === v ? '0 1px 3px rgba(0,0,0,0.15)' : 'none',
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Day start / end hours */}
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Visible Hours</span>
                <div className="flex items-center gap-2">
                  <div className="flex flex-col gap-0.5 flex-1">
                    <span className="text-[9px] font-medium" style={{ color: menuSub }}>From</span>
                    <select
                      value={dayStartH}
                      onChange={e => {
                        const newStart = parseInt(e.target.value);
                        const duration = dayEndH - dayStartH;
                        setDayStartH(newStart);
                        setDayEndH(newStart + duration);
                      }}
                      className="w-full py-1.5 px-2 text-xs font-medium rounded-md transition-all duration-200"
                      style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText, outline: 'none' }}
                    >
                      {Array.from({ length: 24 }, (_, i) => i).map(h => (
                        <option key={h} value={h}>{h === 0 ? '12am' : h < 12 ? `${h}am` : h === 12 ? '12pm' : `${h - 12}pm`}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex flex-col gap-0.5 flex-1">
                    <span className="text-[9px] font-medium" style={{ color: menuSub }}>Duration</span>
                    <select
                      value={dayEndH - dayStartH}
                      onChange={e => setDayEndH(dayStartH + parseInt(e.target.value))}
                      className="w-full py-1.5 px-2 text-xs font-medium rounded-md transition-all duration-200"
                      style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText, outline: 'none' }}
                    >
                      {Array.from({ length: 24 }, (_, i) => i + 1).map(d => (
                        <option key={d} value={d}>{d} {d === 1 ? 'hour' : 'hours'}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <p className="text-[10px] leading-relaxed" style={{ color: menuSub }}>
                  {(() => {
                    const formatHourLabel = (h: number) => {
                      const displayH = h % 24;
                      if (displayH === 0) return '12am';
                      if (displayH === 12) return '12pm';
                      return displayH < 12 ? `${displayH}am` : `${displayH - 12}pm`;
                    };
                    return `${formatHourLabel(dayStartH)} – ${formatHourLabel(dayEndH)} (${dayEndH - dayStartH}h visible)`;
                  })()}
                </p>
              </div>

              {/* Backup & Restore */}
              <hr className="border-t opacity-10" style={{ borderColor: surfaceBdr }} />
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Backup & Restore</span>
                <div className="flex flex-col gap-2">
                  <button
                    onClick={exportBackup}
                    className="w-full py-2 px-3 text-xs font-semibold rounded-md text-center transition-all duration-200"
                    style={{
                      background: surfaceBg,
                      border: `1px solid ${surfaceBdr}`,
                      color: menuText,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                    onMouseLeave={e => (e.currentTarget.style.background = surfaceBg)}
                  >
                    Export Backup (.json)
                  </button>
                  <button
                    onClick={() => document.getElementById('import-backup-file')?.click()}
                    className="w-full py-2 px-3 text-xs font-semibold rounded-md text-center transition-all duration-200"
                    style={{
                      background: surfaceBg,
                      border: `1px solid ${surfaceBdr}`,
                      color: menuText,
                    }}
                    onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                    onMouseLeave={e => (e.currentTarget.style.background = surfaceBg)}
                  >
                    Import Backup
                  </button>
                  <input
                    type="file"
                    accept=".json"
                    id="import-backup-file"
                    onChange={importBackup}
                    style={{ display: 'none' }}
                  />
                </div>
              </div>

            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Context menu (portal-style fixed popover) ────────────────────── */}
      {menuEvent && menuPos && (
        <div
          ref={menuRef}
          className="fixed z-[200] rounded-xl shadow-xl overflow-hidden"
          style={{
            left: Math.min(menuPos.x, window.innerWidth - 220),
            top:  Math.min(menuPos.y, window.innerHeight - 300),
            minWidth: 180,
            background: menuBg,
            border: `1px solid ${menuBdr}`,
            boxShadow: darkMode
              ? '0 8px 32px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset'
              : '0 8px 32px rgba(0,0,0,0.14), 0 1px 0 rgba(255,255,255,0.9) inset',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {/* Event label */}
          <div className="px-3 pt-2.5 pb-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
            <p className="text-[11px] font-semibold truncate" style={{ color: menuText }}>
              {menuEvent.content || 'Untitled'}
            </p>
          </div>

          {/* Precise start/end time editors */}
          <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
            {(['startTime', 'endTime'] as const).map((field, idx) => (
              <div key={field} className="flex flex-col gap-1 flex-1">
                <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: menuSub }}>
                  {idx === 0 ? 'Start' : 'End'}
                </span>
                <input
                  type="time"
                  step={60}
                  value={menuEvent[field]}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) return;
                    setEvents(prev => {
                      const ev = prev[menuEvent.id];
                      if (!ev) return prev;
                      return { ...prev, [menuEvent.id]: { ...ev, [field]: val } };
                    });
                  }}
                  className="w-full text-[11px] font-medium tabular-nums rounded-md px-1.5 py-1 outline-none"
                  style={{ background: hoverBg, border: `1px solid ${menuBdr}`, color: menuText }}
                />
              </div>
            ))}
          </div>

          {/* Completion-checkbox toggle */}
          <button
            className="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-left text-[12px] font-medium transition-colors"
            style={{ color: menuText, borderBottom: `1px solid ${menuBdr}` }}
            onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => setEvents(prev => {
              const ev = prev[menuEvent.id];
              if (!ev) return prev;
              return { ...prev, [menuEvent.id]: { ...ev, noCheckbox: !ev.noCheckbox } };
            })}
          >
            <span className="flex items-center gap-2.5">
              <CheckSquare size={13} style={{ opacity: 0.7 }} />
              Completion checkbox
            </span>
            <span
              className="flex items-center rounded-full transition-colors"
              style={{
                width: 30, height: 17, padding: 2,
                background: !menuEvent.noCheckbox ? '#5b9d5b' : (darkMode ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'),
                justifyContent: !menuEvent.noCheckbox ? 'flex-end' : 'flex-start',
              }}
            >
              <span style={{ width: 13, height: 13, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }} />
            </span>
          </button>

          {/* Color picker */}
          <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
            <span className="text-[9px] font-bold uppercase tracking-wider mr-1" style={{ color: menuSub }}>Color</span>
            {SWATCHES.map(c => {
              const sc = colorPalette[c];
              return (
                <button key={c} type="button"
                  onClick={() => setEvents(prev => {
                    const ev = prev[menuEvent.id];
                    if (!ev) return prev;
                    return { ...prev, [menuEvent.id]: { ...ev, color: c } };
                  })}
                  className="rounded-full border transition-transform hover:scale-110"
                  style={{ width: 15, height: 15, backgroundColor: sc.bg, borderColor: sc.border, outline: menuEvent.color===c ? `2px solid ${sc.text}` : 'none', outlineOffset: 1 }}
                />
              );
            })}
          </div>

          {/* Actions */}
          {[
            {
              icon: <Pencil size={13}/>,
              label: 'Edit',
              action: () => { setEditingId(menuEvent.id); },
            },
            {
              icon: <CalendarRange size={13}/>,
              label: 'Clone to whole week',
              action: () => cloneAcrossWeek(menuEvent),
            },
            {
              icon: <Trash2 size={13}/>,
              label: 'Delete',
              danger: true,
              action: () => deleteEvent(menuEvent.id),
            },
          ].map(({ icon, label, action, danger }) => (
            <button
              key={label}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[12px] font-medium transition-colors"
              style={{ color: danger ? '#e05555' : menuText }}
              onMouseEnter={e => (e.currentTarget.style.background = danger ? 'rgba(224,85,85,0.10)' : hoverBg)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={action}
            >
              <span style={{ opacity: 0.7 }}>{icon}</span>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
