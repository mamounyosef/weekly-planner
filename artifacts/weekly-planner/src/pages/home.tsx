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
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

// ─── Types ────────────────────────────────────────────────────────────────────
type IntervalMin = 15 | 30 | 60;
type EventColor = 'sage' | 'peach' | 'blue' | 'sand' | 'lilac';

interface PlannerEvent {
  id: string;
  dayIndex: number;   // 0 = Mon … 6 = Sun
  startTime: string;  // "HH:MM"
  endTime: string;    // "HH:MM"
  content: string;
  color: EventColor;
}

type PlannerData = Record<string, PlannerEvent>;

// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY = 'planner-v3';
const INTERVAL_KEY = 'planner-interval';
const DAY_START_H = 7;   // 7:00
const DAY_END_H   = 23;  // up to but not including 23:00
const HEADER_PX   = 56;  // matches h-14
const DRAG_THRESHOLD = 5;
const POSITION_SNAP = 5; // all positioning snaps to 5-minute grid

const SLOT_H: Record<IntervalMin, number> = { 15: 40, 30: 64, 60: 96 };

const EVENT_COLORS: Record<EventColor, { bg: string; border: string; text: string }> = {
  sage:  { bg: '#eef1ed', border: '#b8d0b3', text: '#3a5233' },
  peach: { bg: '#fcf2ed', border: '#f0d0bc', text: '#7a4530' },
  blue:  { bg: '#eef3f9', border: '#b8d0ee', text: '#2a4f78' },
  sand:  { bg: '#f9f5ed', border: '#e8d5b8', text: '#6b5030' },
  lilac: { bg: '#f5f1f8', border: '#d8c8ee', text: '#583878' },
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

function uid(): string {
  return crypto.randomUUID();
}

// Convert minutes-since-midnight → pixel Y within the day column content area
function minToY(min: number, interval: IntervalMin): number {
  const relMin = min - DAY_START_H * 60;
  return (relMin / interval) * SLOT_H[interval];
}

// Pixel Y within day column content area → minutes snapped to POSITION_SNAP
function yToMin(y: number, interval: IntervalMin): number {
  const rawMin = DAY_START_H * 60 + (y / SLOT_H[interval]) * interval;
  return snapMin(rawMin, POSITION_SNAP);
}

// ─── Main Component ────────────────────────────────────────────────────────────
export default function WeeklyPlanner() {
  const [currentDate, setCurrentDate]     = useState(new Date());
  const [interval, setIntervalOpt]        = useState<IntervalMin>(60);
  const [events, setEvents]               = useState<PlannerData>({});
  const [editingId, setEditingId]         = useState<string | null>(null);
  const [hoveredId, setHoveredId]         = useState<string | null>(null);
  const [direction, setDirection]         = useState(0);

  // Drag state (stored in refs to avoid stale closures in document listeners)
  const dragRef = useRef<{
    eventId: string;
    durationMin: number;
    offsetMin: number;   // how far into the event the user grabbed
    origDay: number;
    curDay: number;
    curStartMin: number;
    active: boolean;     // threshold exceeded?
    initX: number;
    initY: number;
  } | null>(null);

  // Resize state
  const resizeRef = useRef<{
    eventId: string;
    edge: 'top' | 'bottom';
    startMin: number;
    endMin: number;
  } | null>(null);

  // Display overrides — set during drag/resize so React re-renders smoothly
  const [dragDisp, setDragDisp]     = useState<{ id: string; day: number; startMin: number } | null>(null);
  const [resizeDisp, setResizeDisp] = useState<{ id: string; startMin: number; endMin: number } | null>(null);
  const [clipboard, setClipboard]   = useState<PlannerEvent | null>(null);

  const daysGridRef   = useRef<HTMLDivElement>(null);
  const editRef       = useRef<HTMLTextAreaElement>(null);
  const didDragRef    = useRef(false);  // prevent click-to-edit firing after a drag
  const editingIdRef  = useRef<string | null>(null);
  const hoveredIdRef  = useRef<string | null>(null);
  const eventsRef     = useRef<PlannerData>({});

  // ── Derived ──────────────────────────────────────────────────────────────────
  const weekStart = startOfWeek(currentDate, { weekStartsOn: 1 });
  const days      = eachDayOfInterval({ start: weekStart, end: endOfWeek(currentDate, { weekStartsOn: 1 }) });
  const slots     = generateSlots(interval);
  const sh        = SLOT_H[interval];
  const totalH    = slots.length * sh;
  const dayEndMin = DAY_END_H * 60;
  const dayStartMin = DAY_START_H * 60;

  // ── Persistence ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try { setEvents(JSON.parse(saved)); } catch (_) { /* ignore */ }
    }
    const savedInt = localStorage.getItem(INTERVAL_KEY);
    if (savedInt) setIntervalOpt(parseInt(savedInt) as IntervalMin);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  }, [events]);

  useEffect(() => {
    localStorage.setItem(INTERVAL_KEY, String(interval));
  }, [interval]);

  // Keep refs in sync so keyboard handler always sees fresh values
  useEffect(() => { editingIdRef.current = editingId; }, [editingId]);
  useEffect(() => { hoveredIdRef.current = hoveredId; }, [hoveredId]);
  useEffect(() => { eventsRef.current = events; }, [events]);

  // ── Focus textarea when editing opens ─────────────────────────────────────────
  useEffect(() => {
    if (editingId && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingId]);

  // ── Ctrl+C / Ctrl+V clipboard ─────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const active = document.activeElement;
      // Don't intercept when typing in a textarea/input
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;

      if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
        const targetId = editingIdRef.current ?? hoveredIdRef.current;
        if (!targetId) return;
        const ev = eventsRef.current[targetId];
        if (ev) {
          setClipboard(ev);
          e.preventDefault();
        }
        return;
      }

      if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
        setClipboard(prev => {
          if (!prev) return prev;
          const newId = uid();
          const startMin = timeToMin(prev.startTime);
          const endMin   = timeToMin(prev.endTime);
          const duration = endMin - startMin;
          // Paste 10 minutes after original; clamp to day bounds
          const pasteStart = clamp(startMin + 10, DAY_START_H * 60, DAY_END_H * 60 - duration);
          setEvents(evs => ({
            ...evs,
            [newId]: {
              ...prev,
              id: newId,
              startTime: minToTime(pasteStart),
              endTime: minToTime(pasteStart + duration),
            },
          }));
          setEditingId(newId);
          // Update clipboard to the new copy so repeated pastes cascade
          return { ...prev, id: newId, startTime: minToTime(pasteStart), endTime: minToTime(pasteStart + duration) };
        });
        e.preventDefault();
      }
    };

    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // ── Grid coordinate helper ────────────────────────────────────────────────────
  const getGridCoords = useCallback((clientX: number, clientY: number) => {
    const el = daysGridRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const relX = clientX - rect.left;
    const relY = clientY - rect.top - HEADER_PX;
    const colW = rect.width / 7;
    const dayIndex = clamp(Math.floor(relX / colW), 0, 6);
    const snapped = clamp(yToMin(Math.max(0, relY), interval), dayStartMin, dayEndMin - POSITION_SNAP);
    return { dayIndex, snappedMin: snapped };
  }, [interval, dayStartMin, dayEndMin]);

  // ── Global mouse move / up ────────────────────────────────────────────────────
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const dr = dragRef.current;
      const rr = resizeRef.current;

      if (dr) {
        if (!dr.active) {
          const dist = Math.hypot(e.clientX - dr.initX, e.clientY - dr.initY);
          if (dist >= DRAG_THRESHOLD) {
            dr.active = true;
            didDragRef.current = true;
          } else {
            return;
          }
        }
        const coords = getGridCoords(e.clientX, e.clientY);
        if (!coords) return;
        let newStart = coords.snappedMin - dr.offsetMin;
        newStart = clamp(snapMin(newStart, POSITION_SNAP), dayStartMin, dayEndMin - dr.durationMin);
        dr.curDay = coords.dayIndex;
        dr.curStartMin = newStart;
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

    const onUp = () => {
      const dr = dragRef.current;
      const rr = resizeRef.current;

      if (dr) {
        if (dr.active) {
          setEvents(prev => {
            const ev = prev[dr.eventId];
            if (!ev) return prev;
            return {
              ...prev,
              [dr.eventId]: {
                ...ev,
                dayIndex: dr.curDay,
                startTime: minToTime(dr.curStartMin),
                endTime: minToTime(dr.curStartMin + dr.durationMin),
              },
            };
          });
          // keep didDragRef true long enough for the click handler to see it
          setTimeout(() => { didDragRef.current = false; }, 80);
        } else {
          didDragRef.current = false;
        }
        dragRef.current = null;
        setDragDisp(null);
      }

      if (rr) {
        setEvents(prev => {
          const ev = prev[rr.eventId];
          if (!ev) return prev;
          return {
            ...prev,
            [rr.eventId]: {
              ...ev,
              startTime: minToTime(rr.startMin),
              endTime: minToTime(rr.endMin),
            },
          };
        });
        resizeRef.current = null;
        setResizeDisp(null);
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [getGridCoords, interval, dayStartMin, dayEndMin]);

  // ── Event handlers ────────────────────────────────────────────────────────────
  const handleColClick = (e: React.MouseEvent<HTMLDivElement>, dayIdx: number) => {
    if (didDragRef.current) return;
    // Ignore clicks that bubbled from an event block
    if ((e.target as HTMLElement).closest('[data-event]')) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const relY = e.clientY - rect.top;
    const startMin = clamp(yToMin(Math.max(0, relY), interval), dayStartMin, dayEndMin - interval);
    const id = uid();
    setEvents(prev => ({
      ...prev,
      [id]: {
        id,
        dayIndex: dayIdx,
        startTime: minToTime(startMin),
        endTime: minToTime(startMin + interval),
        content: '',
        color: 'sage',
      },
    }));
    setEditingId(id);
  };

  const handleEventMouseDown = (e: React.MouseEvent, ev: PlannerEvent) => {
    if (editingId === ev.id) return;
    e.preventDefault();
    e.stopPropagation();
    const coords = getGridCoords(e.clientX, e.clientY);
    if (!coords) return;
    const startMin  = timeToMin(ev.startTime);
    const endMin    = timeToMin(ev.endTime);
    const duration  = endMin - startMin;
    const rawOffset = coords.snappedMin - startMin;
    const offsetMin = clamp(rawOffset, 0, duration - interval);
    dragRef.current = {
      eventId: ev.id,
      durationMin: duration,
      offsetMin,
      origDay: ev.dayIndex,
      curDay: ev.dayIndex,
      curStartMin: startMin,
      active: false,
      initX: e.clientX,
      initY: e.clientY,
    };
  };

  const handleResizeMouseDown = (e: React.MouseEvent, ev: PlannerEvent, edge: 'top' | 'bottom') => {
    e.preventDefault();
    e.stopPropagation();
    resizeRef.current = {
      eventId: ev.id,
      edge,
      startMin: timeToMin(ev.startTime),
      endMin: timeToMin(ev.endTime),
    };
  };

  const deleteEvent = (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setEvents(prev => { const n = { ...prev }; delete n[id]; return n; });
    if (editingId === id) setEditingId(null);
  };

  // ── Navigation ────────────────────────────────────────────────────────────────
  const goBack  = () => { setDirection(-1); setCurrentDate(d => subWeeks(d, 1)); setEditingId(null); };
  const goNext  = () => { setDirection(1);  setCurrentDate(d => addWeeks(d, 1));  setEditingId(null); };
  const goToday = () => { setDirection(0);  setCurrentDate(new Date());            setEditingId(null); };

  // ── Display props for an event (override during drag/resize) ─────────────────
  const dispProps = (ev: PlannerEvent) => {
    if (dragDisp?.id === ev.id) {
      const dur = timeToMin(ev.endTime) - timeToMin(ev.startTime);
      return { dayIndex: dragDisp.day, startMin: dragDisp.startMin, endMin: dragDisp.startMin + dur };
    }
    if (resizeDisp?.id === ev.id) {
      return { dayIndex: ev.dayIndex, startMin: resizeDisp.startMin, endMin: resizeDisp.endMin };
    }
    return { dayIndex: ev.dayIndex, startMin: timeToMin(ev.startTime), endMin: timeToMin(ev.endTime) };
  };

  const isDraggingAnything = !!dragDisp;
  const isResizingAnything = !!resizeDisp;
  const globalCursor = isDraggingAnything ? 'grabbing' : isResizingAnything ? 'ns-resize' : undefined;

  // ─── Render ──────────────────────────────────────────────────────────────────
  return (
    <div
      className="min-h-screen bg-background text-foreground flex flex-col font-sans select-none"
      style={{ cursor: globalCursor }}
    >
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-background/85 backdrop-blur-md border-b border-border/50">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-5">
            <span className="text-base font-semibold tracking-tight text-foreground/80">
              {format(weekStart, 'MMMM yyyy')}
            </span>
            <div className="flex items-center bg-white/60 border border-border/70 rounded-lg p-0.5 shadow-sm">
              <button onClick={goBack}  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"><ChevronLeft size={15}/></button>
              <button onClick={goToday} className="px-3 py-1 text-xs font-medium text-foreground/75 hover:text-foreground hover:bg-black/5 rounded-md transition-colors">Today</button>
              <button onClick={goNext}  className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"><ChevronRight size={15}/></button>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-widest">Interval</span>
            <div className="flex bg-white/60 border border-border/70 rounded-lg p-0.5 shadow-sm">
              {([15, 30, 60] as IntervalMin[]).map(v => (
                <button
                  key={v}
                  onClick={() => setIntervalOpt(v)}
                  className={`px-3 py-1 text-xs font-medium rounded-md transition-all duration-200 ${
                    interval === v ? 'bg-white shadow-sm text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {v}m
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* ── Grid ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 overflow-auto">
        <div className="min-w-[900px] max-w-[1400px] mx-auto p-4">
          <AnimatePresence initial={false} custom={direction} mode="wait">
            <motion.div
              key={weekStart.toISOString()}
              custom={direction}
              variants={{
                enter: (d: number) => ({ x: d > 0 ? 20 : d < 0 ? -20 : 0, opacity: 0 }),
                center: { x: 0, opacity: 1 },
                exit:  (d: number) => ({ x: d < 0 ? 20 : d > 0 ? -20 : 0, opacity: 0 }),
              }}
              initial="enter" animate="center" exit="exit"
              transition={{ x: { type: 'spring', stiffness: 300, damping: 30 }, opacity: { duration: 0.15 } }}
              className="flex border border-border/60 rounded-xl overflow-hidden bg-white/30 shadow-sm"
            >
              {/* Time axis */}
              <div className="flex-shrink-0 border-r border-border/50 bg-background/40" style={{ width: 64 }}>
                <div style={{ height: HEADER_PX }} className="border-b border-border/50" />
                <div className="relative" style={{ height: totalH }}>
                  {slots.map((time, i) => {
                    const isHour = time.endsWith(':00');
                    return (
                      <div key={time} className="absolute w-full flex justify-center items-start" style={{ top: i * sh, height: sh }}>
                        <span className={`leading-none px-1 tabular-nums ${
                          isHour
                            ? 'mt-1 text-[10px] font-semibold text-muted-foreground'
                            : 'mt-1 text-[8.5px] text-muted-foreground/40'
                        }`}>
                          {time}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Day columns */}
              <div ref={daysGridRef} className="flex-1 grid grid-cols-7">
                {days.map((day, colIdx) => {
                  const today = isToday(day);

                  // Collect events that display in this column (accounting for drag)
                  const colEvents = Object.values(events).filter(ev => dispProps(ev).dayIndex === colIdx);

                  return (
                    <div
                      key={colIdx}
                      className={`flex flex-col border-r border-border/50 last:border-r-0 ${today ? 'bg-primary/[0.02]' : ''}`}
                    >
                      {/* Day header */}
                      <div
                        className={`flex-shrink-0 flex flex-col items-center justify-center border-b ${today ? 'border-primary/20' : 'border-border/50'}`}
                        style={{ height: HEADER_PX }}
                      >
                        <span className={`text-[9px] font-bold uppercase tracking-widest mb-0.5 ${today ? 'text-primary' : 'text-muted-foreground'}`}>
                          {format(day, 'EEE')}
                        </span>
                        <span className={`text-lg font-semibold leading-none ${today ? 'text-primary' : 'text-foreground/70'}`}>
                          {format(day, 'd')}
                        </span>
                      </div>

                      {/* Content area */}
                      <div
                        className="relative"
                        style={{ height: totalH, cursor: isDraggingAnything ? 'grabbing' : 'crosshair' }}
                        onClick={(e) => handleColClick(e, colIdx)}
                      >
                        {/* Grid lines (pointer-events-none so clicks pass through) */}
                        {slots.map((time, i) => (
                          <div
                            key={time}
                            className={`absolute w-full pointer-events-none border-b ${time.endsWith(':00') ? 'border-border/35' : 'border-border/12'}`}
                            style={{ top: i * sh, height: sh }}
                          />
                        ))}

                        {/* Events */}
                        {colEvents.map(ev => {
                          const dp = dispProps(ev);
                          const top    = minToY(dp.startMin, interval);
                          const height = Math.max(sh, minToY(dp.endMin, interval) - top);
                          const isDrag = dragDisp?.id === ev.id;
                          const isEdit = editingId === ev.id;
                          const isHov  = hoveredId === ev.id;
                          const { bg, border, text } = EVENT_COLORS[ev.color];
                          const tooShort = height < sh * 2; // can't show color picker

                          return (
                            <div
                              key={ev.id}
                              data-event="1"
                              className={`absolute rounded-lg border overflow-visible transition-shadow duration-150 ${isDrag ? 'shadow-2xl z-50' : isEdit ? 'z-40 shadow-md' : 'z-10 shadow-sm hover:shadow-md'}`}
                              style={{
                                top,
                                height,
                                left: 3,
                                right: 3,
                                backgroundColor: bg,
                                borderColor: border,
                                color: text,
                                cursor: isDrag ? 'grabbing' : isEdit ? 'text' : 'grab',
                                opacity: isDrag ? 0.82 : 1,
                              }}
                              onMouseDown={(e) => handleEventMouseDown(e, ev)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!didDragRef.current) setEditingId(ev.id);
                              }}
                              onMouseEnter={() => setHoveredId(ev.id)}
                              onMouseLeave={() => setHoveredId(null)}
                            >
                              {/* ── Top resize handle ── */}
                              <div
                                className="absolute top-0 left-0 right-0 flex items-center justify-center z-20"
                                style={{ height: 8, cursor: 'n-resize' }}
                                onMouseDown={(e) => handleResizeMouseDown(e, ev, 'top')}
                              >
                                <div
                                  className="rounded-full transition-opacity duration-150"
                                  style={{
                                    width: 28,
                                    height: 3,
                                    backgroundColor: text,
                                    opacity: isHov || isEdit ? 0.25 : 0,
                                  }}
                                />
                              </div>

                              {/* ── Content ── */}
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
                                      <div
                                        className="flex items-center gap-1 pt-1 flex-shrink-0"
                                        onMouseDown={e => e.preventDefault()}
                                      >
                                        {SWATCHES.map(c => {
                                          const sc = EVENT_COLORS[c];
                                          return (
                                            <button
                                              key={c}
                                              type="button"
                                              onClick={e => {
                                                e.stopPropagation();
                                                setEvents(prev => ({ ...prev, [ev.id]: { ...prev[ev.id], color: c } }));
                                              }}
                                              className="rounded-full border transition-transform hover:scale-110"
                                              style={{
                                                width: 11,
                                                height: 11,
                                                backgroundColor: sc.bg,
                                                borderColor: sc.border,
                                                outline: ev.color === c ? `2px solid ${sc.text}` : 'none',
                                                outlineOffset: 1,
                                              }}
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

                              {/* ── Delete button ── */}
                              {(isHov || isEdit) && !isDrag && (
                                <button
                                  className="absolute top-1 right-1 z-30 flex items-center justify-center rounded transition-opacity"
                                  style={{
                                    width: 14,
                                    height: 14,
                                    color: text,
                                    opacity: 0.35,
                                    backgroundColor: 'transparent',
                                  }}
                                  onMouseEnter={e => (e.currentTarget.style.opacity = '0.7')}
                                  onMouseLeave={e => (e.currentTarget.style.opacity = '0.35')}
                                  onClick={e => deleteEvent(e, ev.id)}
                                  onMouseDown={e => e.stopPropagation()}
                                >
                                  <X size={10} strokeWidth={2.5} />
                                </button>
                              )}

                              {/* ── Bottom resize handle ── */}
                              <div
                                className="absolute bottom-0 left-0 right-0 flex items-center justify-center z-20"
                                style={{ height: 8, cursor: 's-resize' }}
                                onMouseDown={(e) => handleResizeMouseDown(e, ev, 'bottom')}
                              >
                                <div
                                  className="rounded-full transition-opacity duration-150"
                                  style={{
                                    width: 28,
                                    height: 3,
                                    backgroundColor: text,
                                    opacity: isHov || isEdit ? 0.25 : 0,
                                  }}
                                />
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
    </div>
  );
}
