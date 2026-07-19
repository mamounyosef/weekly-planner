import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  format,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isToday,
} from 'date-fns';
import { X, Calendar, Clock, Minus, ExternalLink, Pin } from 'lucide-react';

// ─── Types & Constants ────────────────────────────────────────────────────────
type IntervalMin   = 5 | 15 | 30 | 60;
type EventColor    = 'sage' | 'peach' | 'blue' | 'sand' | 'lilac';
type TimeFormat    = '12h' | '24h';
type WeekStartsOn  = 0 | 1 | 2 | 3 | 4 | 5 | 6;

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

const STORAGE_KEY      = 'planner-v3';
const INTERVAL_KEY     = 'planner-interval';
const DARK_MODE_KEY    = 'planner-dark';
const TIME_FORMAT_KEY  = 'planner-timefmt';
const WEEK_START_KEY  = 'planner-weekstart';
const DAY_START_KEY  = 'planner-daystart';
const DAY_END_KEY    = 'planner-dayend';
const HEADER_PX      = 48;
const POSITION_SNAP  = 5;

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

// ─── Utilities ────────────────────────────────────────────────────────────────
function timeToMin(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
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

function snapMin(min: number, interval: IntervalMin): number {
  return Math.round(min / interval) * interval;
}

// ─── Parallel layout helper ───────────────────────────────────────────────────
function layoutParallel(
  evs: Array<{ id: string; startMin: number; endMin: number }>,
): Map<string, { col: number; numCols: number }> {
  const sorted = [...evs].sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  const colEnds: number[] = [];
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

export default function Widget() {
  const [events, setEvents]           = useState<PlannerData>({});
  const [interval, setIntervalOpt]    = useState<IntervalMin>(5);
  const [darkMode, setDarkMode]       = useState(true);
  const [timeFormat, setTimeFormat]   = useState<TimeFormat>('12h');
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(0);
  const [dayStartH, setDayStartH]       = useState(7);
  const [dayEndH, setDayEndH]           = useState(31);
  const [nowTick, setNowTick]           = useState(Date.now());
  const [isPinned, setIsPinned]         = useState(true);

  // ── Load Settings and initial events ───────────────────────────────────────
  useEffect(() => {
    // Fallback load local storage for events only
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { try { setEvents(JSON.parse(saved)); } catch (_) {} }

    // Settings come from the shared backend so the widget always matches the main window.
    const loadSettings = () => {
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
        .catch(err => console.error('Failed to sync widget settings:', err));
    };

    // Fetch live from server & poll
    const loadEvents = () => {
      fetch('/api/events')
        .then(r => r.json())
        .then(data => {
          if (data && typeof data === 'object') {
            setEvents(data);
          }
        })
        .catch(err => console.error('Failed to sync widget database:', err));
    };

    loadSettings();
    loadEvents();
    const settingsPollId = setInterval(loadSettings, 5000);
    const pollId = setInterval(loadEvents, 5000);
    const clockId = setInterval(() => setNowTick(Date.now()), 1000);

    return () => {
      clearInterval(settingsPollId);
      clearInterval(pollId);
      clearInterval(clockId);
    };
  }, []);

  // ── Derived variables ──────────────────────────────────────────────────────
  const today = new Date(nowTick);
  const weekStart = startOfWeek(today, { weekStartsOn });
  const days = eachDayOfInterval({ start: weekStart, end: endOfWeek(today, { weekStartsOn }) });
  const todayColIdx = days.findIndex(d => isToday(d));

  const slots = generateSlots(interval, dayStartH, dayEndH);
  const sh = SLOT_H[interval];
  const totalH = slots.length * sh;
  const dayStartMin = dayStartH * 60;
  const dayEndMin = dayEndH * 60;
  const colorPalette = darkMode ? DARK_EVENT_COLORS : EVENT_COLORS;

  const nowMin = today.getHours() * 60 + today.getMinutes();
  const normNowMin = normalizeMin(nowMin, dayStartH);
  const nowInView = normNowMin >= dayStartMin && normNowMin <= dayEndMin;

  const colEvents = useMemo(() => {
    if (todayColIdx === -1) return [];
    return Object.values(events).filter(ev => ev.dayIndex === todayColIdx);
  }, [events, todayColIdx]);

  const layout = useMemo(() => {
    const layoutInput = colEvents.map(ev => ({
      id: ev.id,
      startMin: timeToMin(ev.startTime),
      endMin: timeToMin(ev.endTime),
    }));
    return layoutParallel(layoutInput);
  }, [colEvents]);

  // ── Scroll & Live indicator visibility logic ──────────────────────────────
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [showLiveBtn, setShowLiveBtn] = useState(false);
  const isProgrammaticScroll = useRef(false);
  const isTrackingLive = useRef(true);

  const checkLiveVisibility = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const lineTop = minToY(normNowMin, interval, dayStartH);
    const isVisible = lineTop >= container.scrollTop && lineTop <= container.scrollTop + container.clientHeight;
    setShowLiveBtn(!isVisible);
  }, [normNowMin, interval, dayStartH]);

  const scrollAnimFrame = useRef(0);
  const centerScrollOnLive = (smooth = true) => {
    const container = scrollContainerRef.current;
    if (!container || container.clientHeight === 0) return;
    const lineTop = minToY(normNowMin, interval, dayStartH);
    const targetTop = lineTop - container.clientHeight / 2;

    if (!smooth) {
      isProgrammaticScroll.current = true;
      container.scrollTop = targetTop;
      return;
    }

    // Custom eased scroll animation (800ms, easeInOutCubic)
    const startTop = container.scrollTop;
    const distance = targetTop - startTop;
    if (Math.abs(distance) < 2) return;
    const duration = 800;
    const startTime = performance.now();

    if (scrollAnimFrame.current) cancelAnimationFrame(scrollAnimFrame.current);

    const easeInOutCubic = (t: number) =>
      t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

    const step = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = easeInOutCubic(progress);
      isProgrammaticScroll.current = true;
      container.scrollTop = startTop + distance * eased;

      if (progress < 1) {
        scrollAnimFrame.current = requestAnimationFrame(step);
      } else {
        scrollAnimFrame.current = 0;
      }
    };

    scrollAnimFrame.current = requestAnimationFrame(step);
  };

  const handleScroll = () => {
    if (isProgrammaticScroll.current) {
      isProgrammaticScroll.current = false;
      return;
    }
    
    // Check if the live line is visible in the container
    const container = scrollContainerRef.current;
    if (container) {
      const lineTop = minToY(normNowMin, interval, dayStartH);
      const isVisible = lineTop >= container.scrollTop && lineTop <= container.scrollTop + container.clientHeight;
      setShowLiveBtn(!isVisible);
    }
    
    // If the user scrolls away, pause live tracking
    if (isTrackingLive.current) {
      isTrackingLive.current = false;
    }
  };

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    checkLiveVisibility();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [checkLiveVisibility]);

  // Initial centering scroll (waits for container height to render fully)
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container || slots.length === 0) return;
    
    let attempts = 0;
    const scrollInitial = () => {
      if (container.clientHeight > 0) {
        if (isTrackingLive.current) {
          centerScrollOnLive(false);
        }
      } else if (attempts < 10) {
        attempts++;
        requestAnimationFrame(scrollInitial);
      }
    };
    requestAnimationFrame(scrollInitial);
  }, [slots, dayStartH, interval]);

  // Keep centering dynamically every time the live time updates
  const lastCenteringMin = useRef(-1);
  useEffect(() => {
    const currentMin = Math.floor(normNowMin);
    if (currentMin === lastCenteringMin.current) return;
    lastCenteringMin.current = currentMin;

    if (isTrackingLive.current) {
      centerScrollOnLive(true);
    }
  }, [nowTick, normNowMin]);

  const scrollToLive = () => {
    isTrackingLive.current = true;
    setShowLiveBtn(false);
    centerScrollOnLive(true);
  };

  const minimizeWidget = () => {
    if ((window as any).pywebview?.api?.minimize) {
      (window as any).pywebview.api.minimize();
    }
  };

  const closeWidget = () => {
    if ((window as any).pywebview?.api?.close) {
      (window as any).pywebview.api.close();
    } else {
      window.close();
    }
  };

  const openMainSite = () => {
    if ((window as any).pywebview?.api?.open_browser) {
      (window as any).pywebview.api.open_browser();
    } else {
      const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
      window.open(window.location.origin + basePath + '/', '_blank');
    }
  };

  const togglePin = () => {
    const nextState = !isPinned;
    setIsPinned(nextState);
    if ((window as any).pywebview?.api?.set_always_on_top) {
      (window as any).pywebview.api.set_always_on_top(nextState);
    }
  };

  const toggleEventCompleted = (id: string) => {
    const todayDate = new Date();
    const dateStr = format(todayDate, 'yyyy-MM-dd');
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
      }).catch(err => console.error("Failed to save checkbox state from widget:", err));
      
      return updatedEvents;
    });
  };

  const handleHeaderMouseDown = (e: React.MouseEvent) => {
    if (e.button === 0) {
      let isDragging = true;
      let startX = e.screenX;
      let startY = e.screenY;
      
      const handleMouseMove = (ev: MouseEvent) => {
        if (!isDragging) return;
        const dx = ev.screenX - startX;
        const dy = ev.screenY - startY;
        if (dx !== 0 || dy !== 0) {
          startX = ev.screenX;
          startY = ev.screenY;
          if ((window as any).pywebview?.api?.move_window_relative) {
            (window as any).pywebview.api.move_window_relative(dx, dy);
          }
        }
      };

      const handleMouseUp = () => {
        isDragging = false;
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
      };

      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }
  };

  // ── Style overrides ────────────────────────────────────────────────────────
  const surfaceBg  = darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.60)';
  const surfaceBdr = darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
  const menuText   = darkMode ? '#e8e8e8' : '#1a1a1a';
  const menuSub    = darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';

  return (
    <div className={`h-screen bg-background text-foreground flex flex-col font-sans select-none overflow-hidden ${darkMode ? 'dark' : ''}`} style={{ background: darkMode ? '#20242c' : '#f5f5f7' }}>
      <style>{`
        /* Hide scrollbars globally in the widget window */
        html, body, #root {
          margin: 0;
          padding: 0;
          overflow: hidden !important;
          height: 100%;
          width: 100%;
        }
        *::-webkit-scrollbar {
          display: none !important;
        }
        * {
          -ms-overflow-style: none !important;
          scrollbar-width: none !important;
        }
      `}</style>
      {/* Drag handle header for pywebview */}
      <header
        onMouseDown={handleHeaderMouseDown}
        className="pywebview-drag sticky top-0 z-30 bg-background/80 backdrop-blur-md border-b border-border/50 flex items-center justify-between px-4 h-12 cursor-move"
      >
        <div className="flex items-center gap-2 pointer-events-none">
          <Calendar size={15} className="text-primary" />
          <span className="text-xs font-bold tracking-tight text-foreground/80 tabular-nums">
            {format(today, 'EEEE, MMMM d • h:mm:ss a')}
          </span>
        </div>
        <div className="flex items-center gap-1.5 pointer-events-auto">
          <button
            onClick={togglePin}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/15 transition-all duration-200"
            title={isPinned ? "Unpin Widget" : "Pin Widget"}
            style={{
              color: isPinned ? '#3b82f6' : 'inherit',
              transform: isPinned ? 'rotate(45deg)' : 'none'
            }}
          >
            <Pin size={14} />
          </button>
          <button
            onClick={openMainSite}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/15 transition-colors"
            title="Open Website"
          >
            <ExternalLink size={14} />
          </button>
          <button
            onClick={minimizeWidget}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/15 transition-colors"
            title="Minimize Widget"
          >
            <Minus size={14} />
          </button>
          <button
            onClick={closeWidget}
            className="p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-destructive/15 transition-colors"
            title="Close Widget"
          >
            <X size={14} />
          </button>
        </div>
      </header>

      {/* Timeline Column */}
      <main ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto flex no-scrollbar">
        {/* Time axis */}
        <div className="flex-shrink-0 border-r border-border/50" style={{ width: 56, background: darkMode ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.30)' }}>
          <div className="relative" style={{ height: totalH }}>
            {slots.map((time, i) => {
              const isHour = time.endsWith(':00');
              return (
                <div key={time} className="absolute w-full flex justify-center items-start" style={{ top: i * sh, height: sh }}>
                  <span className={`leading-none px-1 tabular-nums ${isHour ? 'mt-1 text-[9px] font-semibold text-muted-foreground' : 'mt-1 text-[7.5px] text-muted-foreground/30'}`}>
                    {formatSlotLabel(time, timeFormat)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 relative" style={{ height: totalH }}>
          {/* Grid lines */}
          {slots.map((time, i) => (
            <div key={time} className={`absolute w-full pointer-events-none border-b ${time.endsWith(':00') ? 'border-border/35' : 'border-border/12'}`} style={{ top: i * sh, height: sh }} />
          ))}

          {/* Live time indicator */}
          {nowInView && (() => {
            const lineTop = minToY(normNowMin, interval, dayStartH);
            return (
              <div className="absolute left-0 right-0 z-30 pointer-events-none" style={{ top: lineTop, height: 0 }}>
                <div className="absolute -left-[1.5px]" style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', top: -3 }} />
                <div className="absolute left-0 right-0" style={{ height: 1.5, background: '#ef4444', opacity: 0.65 }} />
              </div>
            );
          })()}

          {/* Events list */}
          {colEvents.map(ev => {
            const evStart = timeToMin(ev.startTime);
            const evEnd = timeToMin(ev.endTime);
            const top = minToY(evStart, interval, dayStartH);
            const height = Math.max(sh, minToY(evEnd, interval, dayStartH) - top);
            const { bg, border, text } = colorPalette[ev.color];

            const { col, numCols } = layout.get(ev.id) ?? { col: 0, numCols: 1 };
            const colW = 100 / numCols;
            const leftPct = col * colW;
            const rightPct = 100 - (col + 1) * colW;
            const EDGE = 3;

            const todayDate = new Date();
            const dateStr = format(todayDate, 'yyyy-MM-dd');
            const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(dateStr) ?? false);

            return (
              <div
                key={ev.id}
                className="absolute rounded-lg border shadow-sm transition-shadow duration-150 z-10"
                style={{
                  top, height,
                  left:  `calc(${leftPct}% + ${EDGE}px)`,
                  right: `calc(${rightPct}% + ${EDGE}px)`,
                  backgroundColor: bg,
                  borderColor: border,
                  color: text,
                }}
              >
                <div className="absolute inset-0 px-2 py-1.5 flex flex-col overflow-hidden">
                  <div className="flex items-start gap-1.5 flex-1 min-h-0">
                    {!ev.noCheckbox && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleEventCompleted(ev.id);
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
                    <p className={`text-[11px] font-semibold leading-tight break-words line-clamp-4 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                      {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic' }}>Untitled</span>}
                    </p>
                  </div>
                  {height >= sh * 1.5 && (
                    <span className="text-[8px] mt-0.5 font-medium whitespace-nowrap tabular-nums pl-5 flex-shrink-0" style={{ color: text, opacity: 0.45 }}>
                      {formatTimeLabel(evStart, timeFormat)} – {formatTimeLabel(evEnd, timeFormat)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </main>

      {/* Floating "Go to Live" Button */}
      {showLiveBtn && (
        <button
          onClick={scrollToLive}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-4 py-2.5 rounded-full text-xs font-semibold shadow-lg backdrop-blur-md transition-all duration-300 active:scale-95 animate-in fade-in slide-in-from-bottom-2"
          style={{
            background: darkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.70)',
            border: `1px solid ${darkMode ? 'rgba(255, 255, 255, 0.20)' : 'rgba(0, 0, 0, 0.10)'}`,
            color: '#ffffff',
          }}
        >
          <Clock size={12} />
          Go to Live
        </button>
      )}
    </div>
  );
}
