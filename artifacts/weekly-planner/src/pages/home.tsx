import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  format,
  addWeeks,
  subWeeks,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isToday,
} from 'date-fns';
import { ChevronLeft, ChevronRight, X, Moon, Sun, Pencil, CalendarRange, Trash2, Settings } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

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
}

type PlannerData = Record<string, PlannerEvent>;

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY      = 'planner-v3';
const INTERVAL_KEY     = 'planner-interval';
const DARK_MODE_KEY    = 'planner-dark';
const TIME_FORMAT_KEY  = 'planner-timefmt';
const WEEK_START_KEY  = 'planner-weekstart';
const DAY_START_H    = 7;
const DAY_END_H      = 23;
const HEADER_PX      = 56;
const DRAG_THRESHOLD = 5;
const POSITION_SNAP  = 5;
const COL_GAP        = 2; // px gap between parallel events

const SLOT_H: Record<IntervalMin, number> = { 5: 16, 15: 40, 30: 64, 60: 96 };

const EVENT_COLORS: Record<EventColor, { bg: string; border: string; text: string }> = {
  sage:  { bg: '#eef1ed', border: '#b8d0b3', text: '#3a5233' },
  peach: { bg: '#fcf2ed', border: '#f0d0bc', text: '#7a4530' },
  blue:  { bg: '#eef3f9', border: '#b8d0ee', text: '#2a4f78' },
  sand:  { bg: '#f9f5ed', border: '#e8d5b8', text: '#6b5030' },
  lilac: { bg: '#f5f1f8', border: '#d8c8ee', text: '#583878' },
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
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
function formatTimeLabel(min: number, fmt: TimeFormat = '12h'): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
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
function generateSlots(interval: IntervalMin): string[] {
  const slots: string[] = [];
  for (let h = DAY_START_H; h < DAY_END_H; h++) {
    for (let m = 0; m < 60; m += interval) {
      slots.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }
  return slots;
}
function uid(): string { return crypto.randomUUID(); }
function minToY(min: number, interval: IntervalMin): number {
  return ((min - DAY_START_H * 60) / interval) * SLOT_H[interval];
}
function yToMin(y: number, interval: IntervalMin): number {
  return snapMin(DAY_START_H * 60 + (y / SLOT_H[interval]) * interval, POSITION_SNAP);
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
  const [interval, setIntervalOpt]    = useState<IntervalMin>(60);
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
  const [selRect, setSelRect]           = useState<{ col: number; topPx: number; heightPx: number } | null>(null);
  const [batchDisp, setBatchDisp]       = useState<{ [id: string]: { dayIndex: number; startMin: number } } | null>(null);

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
  const [clipboard, setClipboard]   = useState<PlannerEvent | null>(null);

  const daysGridRef  = useRef<HTMLDivElement>(null);
  const editRef      = useRef<HTMLTextAreaElement>(null);
  const menuRef      = useRef<HTMLDivElement>(null);
  const settingsRef    = useRef<HTMLDivElement>(null);
  const selectedIdsRef = useRef<Set<string>>(new Set());
  const batchDragRef   = useRef<{
    eventIds: string[]; baseStartMins: Record<string, number>; durations: Record<string, number>;
    origDay: number; curDay: number; baseMouseMin: number;
    active: boolean; initX: number; initY: number;
  } | null>(null);
  const batchDispRef   = useRef<{ [id: string]: { dayIndex: number; startMin: number } } | null>(null);
  const selDragRef     = useRef<{ col: number; startY: number } | null>(null);
  const didDragRef     = useRef(false);
  const editingIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const eventsRef    = useRef<PlannerData>({});

  // ── Derived ───────────────────────────────────────────────────────────────
  const weekStart   = startOfWeek(currentDate, { weekStartsOn });
  const days        = eachDayOfInterval({ start: weekStart, end: endOfWeek(currentDate, { weekStartsOn }) });
  const slots       = generateSlots(interval);
  const sh          = SLOT_H[interval];
  const totalH      = slots.length * sh;
  const dayEndMin   = DAY_END_H * 60;
  const dayStartMin = DAY_START_H * 60;
  const colorPalette = darkMode ? DARK_EVENT_COLORS : EVENT_COLORS;

  // ── Persistence ──────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { try { setEvents(JSON.parse(saved)); } catch (_) {} }
    const savedInt = localStorage.getItem(INTERVAL_KEY);
    if (savedInt) setIntervalOpt(parseInt(savedInt) as IntervalMin);
    const savedDark = localStorage.getItem(DARK_MODE_KEY);
    if (savedDark === 'false') setDarkMode(false);
    const savedFmt = localStorage.getItem(TIME_FORMAT_KEY);
    if (savedFmt === '24h') setTimeFormat('24h');
    const savedWeek = localStorage.getItem(WEEK_START_KEY);
    if (savedWeek) setWeekStartsOn(parseInt(savedWeek) as WeekStartsOn);
  }, []);

  useEffect(() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(events)); }, [events]);
  useEffect(() => { localStorage.setItem(INTERVAL_KEY, String(interval)); }, [interval]);
  useEffect(() => { localStorage.setItem(DARK_MODE_KEY, String(darkMode)); }, [darkMode]);
  useEffect(() => { localStorage.setItem(TIME_FORMAT_KEY, timeFormat); }, [timeFormat]);
  useEffect(() => { localStorage.setItem(WEEK_START_KEY, String(weekStartsOn)); }, [weekStartsOn]);

  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);
  useEffect(() => { hoveredIdRef.current = hoveredId; }, [hoveredId]);
  useEffect(() => { eventsRef.current = events; }, [events]);
  useEffect(() => { selectedIdsRef.current = selectedIds; }, [selectedIds]);

  // ── Clear selection on Escape ─────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectedIdsRef.current.size > 0) {
        setSelectedIds(new Set());
        setMenuId(null); setMenuPos(null);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuId(null);
        setMenuPos(null);
      }
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

  // ── Ctrl+C / Ctrl+V ──────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;
      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        const targetId = editingIdRef.current ?? hoveredIdRef.current;
        if (!targetId) return;
        const ev = eventsRef.current[targetId];
        if (ev) { setClipboard(ev); e.preventDefault(); }
      }
      if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
        setClipboard(prev => {
          if (!prev) return prev;
          const newId      = uid();
          const startMin   = timeToMin(prev.startTime);
          const duration   = timeToMin(prev.endTime) - startMin;
          const pasteStart = clamp(startMin + 10, DAY_START_H * 60, DAY_END_H * 60 - duration);
          setEvents(evs => ({ ...evs, [newId]: { ...prev, id: newId, startTime: minToTime(pasteStart), endTime: minToTime(pasteStart + duration) } }));
          setEditingId(newId);
          return { ...prev, id: newId, startTime: minToTime(pasteStart), endTime: minToTime(pasteStart + duration) };
        });
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Grid coordinate helper ────────────────────────────────────────────────
  const getGridCoords = useCallback((clientX: number, clientY: number) => {
    const el = daysGridRef.current;
    if (!el) return null;
    const rect     = el.getBoundingClientRect();
    const colW     = rect.width / 7;
    const dayIndex = clamp(Math.floor((clientX - rect.left) / colW), 0, 6);
    const snapped  = clamp(yToMin(Math.max(0, clientY - rect.top - HEADER_PX), interval), dayStartMin, dayEndMin - POSITION_SNAP);
    return { dayIndex, snappedMin: snapped };
  }, [interval, dayStartMin, dayEndMin]);

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
        const deltaMin = clamp(snapMin(coords.snappedMin - br.baseMouseMin, POSITION_SNAP), -dayStartMin * 4, dayEndMin);
        const newBatchDisp: { [id: string]: { dayIndex: number; startMin: number } } = {};
        for (const id of br.eventIds) {
          const newStart = clamp(br.baseStartMins[id] + deltaMin, dayStartMin, dayEndMin - br.durations[id]);
          newBatchDisp[id] = { dayIndex: br.curDay, startMin: newStart };
        }
        setBatchDisp(newBatchDisp);
        batchDispRef.current = newBatchDisp;
        return;
      }

      // Rubber-band selection (Ctrl+drag on empty column area)
      if (sr) {
        const rect = daysGridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const curY = e.clientY - rect.top - HEADER_PX;
        const startY = sr.startY;
        const topPx = Math.min(startY, curY);
        const heightPx = Math.abs(curY - startY);
        setSelRect({ col: sr.col, topPx, heightPx });
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
        const colRect = daysGridRef.current?.getBoundingClientRect();
        if (colRect) {
          const endY = e.clientY - colRect.top - HEADER_PX;
          const topPx = Math.min(sr.startY, endY);
          const bottomPx = Math.max(sr.startY, endY);
          const topMin = yToMin(Math.max(0, topPx), interval);
          const bottomMin = yToMin(Math.max(0, bottomPx), interval);
          const idsToAdd: string[] = [];
          for (const [id, ev] of Object.entries(eventsRef.current)) {
            if (ev.dayIndex !== sr.col) continue;
            const evStart = timeToMin(ev.startTime);
            const evEnd = timeToMin(ev.endTime);
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
    const startMin = clamp(yToMin(Math.max(0, e.clientY - rect.top), interval), dayStartMin, dayEndMin - interval);
    const id       = uid();
    setEvents(prev => ({ ...prev, [id]: { id, dayIndex: dayIdx, startTime: minToTime(startMin), endTime: minToTime(startMin + interval), content: '', color: 'sage' } }));
    setEditingId(id);
    setMenuId(null);
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
      const durations: Record<string, number> = {};
      for (const id of selectedIds) {
        const eRef = eventsRef.current[id];
        if (eRef) {
          baseStartMins[id] = timeToMin(eRef.startTime);
          durations[id] = timeToMin(eRef.endTime) - timeToMin(eRef.startTime);
        }
      }
      batchDragRef.current = {
        eventIds: [...selectedIds], baseStartMins, durations,
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
    const startMin = timeToMin(ev.startTime);
    const duration = timeToMin(ev.endTime) - startMin;
    dragRef.current = {
      eventId: ev.id, durationMin: duration,
      offsetMin: clamp(coords.snappedMin - startMin, 0, duration - interval),
      origDay: ev.dayIndex, curDay: ev.dayIndex, curStartMin: startMin,
      active: false, initX: e.clientX, initY: e.clientY,
    };
  };

  const handleResizeMouseDown = (e: React.MouseEvent, ev: PlannerEvent, edge: 'top' | 'bottom') => {
    e.preventDefault(); e.stopPropagation();
    resizeRef.current = { eventId: ev.id, edge, startMin: timeToMin(ev.startTime), endMin: timeToMin(ev.endTime) };
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
  const dispProps = (ev: PlannerEvent) => {
    if (batchDisp && batchDisp[ev.id]) {
      const bd = batchDisp[ev.id];
      const dur = timeToMin(ev.endTime) - timeToMin(ev.startTime);
      return { dayIndex: bd.dayIndex, startMin: bd.startMin, endMin: bd.startMin + dur };
    }
    if (dragDisp?.id === ev.id) {
      const dur = timeToMin(ev.endTime) - timeToMin(ev.startTime);
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
            <button onClick={() => setSettingsOpen(s => !s)} title="Settings" className="p-1.5 rounded-lg transition-colors" style={{ background: settingsOpen ? (darkMode?'rgba(255,255,255,0.14)':'rgba(0,0,0,0.08)') : surfaceBg, border: `1px solid ${settingsOpen ? (darkMode?'rgba(255,255,255,0.22)':surfaceBdr) : surfaceBdr}`, color: settingsOpen ? 'var(--color-foreground)' : 'var(--color-muted-foreground)' }}>
              <Settings size={14}/>
            </button>
          </div>
        </div>
      </header>

      {/* ── Grid ────────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        <div className="min-w-[900px] max-w-[1400px] mx-auto p-4">
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
                      <div key={time} className="absolute w-full flex justify-center items-start" style={{ top: i*sh, height: sh }}>
                        <span className={`leading-none px-1 tabular-nums ${isHour ? 'mt-1 text-[10px] font-semibold text-muted-foreground' : 'mt-1 text-[8.5px] text-muted-foreground/40'}`}>
                          {formatSlotLabel(time, timeFormat)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Day columns */}
              <div ref={daysGridRef} className="flex-1 grid grid-cols-7">
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
                          if ((e.ctrlKey || e.metaKey) && !(e.target as HTMLElement).closest('[data-event]')) {
                            const rect = e.currentTarget.getBoundingClientRect();
                            selDragRef.current = { col: colIdx, startY: e.clientY - rect.top };
                            setSelRect({ col: colIdx, topPx: e.clientY - rect.top, heightPx: 0 });
                          }
                        }}
                      >
                        {/* Grid lines */}
                        {slots.map((time, i) => (
                          <div key={time} className={`absolute w-full pointer-events-none border-b ${time.endsWith(':00') ? 'border-border/35' : 'border-border/12'}`} style={{ top: i*sh, height: sh }} />
                        ))}

                        {/* Selection rectangle overlay */}
                        {selRect && selRect.col === colIdx && (
                          <div className="absolute pointer-events-none z-20 rounded-md" style={{
                            top: selRect.topPx,
                            height: Math.max(4, selRect.heightPx),
                            left: 4, right: 4,
                            background: darkMode ? 'rgba(120,180,240,0.18)' : 'rgba(60,120,200,0.13)',
                            border: `1.5px solid ${darkMode ? 'rgba(120,180,240,0.40)' : 'rgba(60,120,200,0.30)'}`,
                            borderRadius: 6,
                          }} />
                        )}

                        {/* Events */}
                        {colEvents.map(ev => {
                          const dp       = dispProps(ev);
                          const top      = minToY(dp.startMin, interval);
                          const height   = Math.max(sh, minToY(dp.endMin, interval) - top);
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
                              onDoubleClick={(e) => { e.stopPropagation(); setMenuId(null); setEditingId(ev.id); }}
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
                                ) : (
                                  <p className="text-xs font-medium leading-snug break-words line-clamp-5" style={{ color: text }}>
                                    {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                                  </p>
                                )}
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
                      className="absolute top-0.5 rounded-full transition-transform duration-200"
                      style={{
                        width: 15, height: 15,
                        background: darkMode ? '#fff' : menuSub,
                        transform: darkMode ? 'translateX(17px)' : 'translateX(2px)',
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
            left: Math.min(menuPos.x, window.innerWidth - 200),
            top:  Math.min(menuPos.y, window.innerHeight - 160),
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
            <p className="text-[10px] mt-0.5" style={{ color: menuSub }}>
              {formatTimeLabel(timeToMin(menuEvent.startTime), timeFormat)} – {formatTimeLabel(timeToMin(menuEvent.endTime), timeFormat)}
            </p>
          </div>

          {/* Actions */}
          {[
            {
              icon: <Pencil size={13}/>,
              label: 'Edit',
              action: () => { setEditingId(menuEvent.id); setMenuId(null); setMenuPos(null); },
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
