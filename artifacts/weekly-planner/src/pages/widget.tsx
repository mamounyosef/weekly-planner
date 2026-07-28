import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  format,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isToday,
  subDays,
  isSameDay,
} from 'date-fns';
import { X, Calendar, Clock, Minus, ExternalLink, Pin, Play, Pause, RotateCcw, Square, Plus, ChevronUp, ChevronDown } from 'lucide-react';
import { motion } from 'framer-motion';
import {
  DEFAULT_FOCUS_TIMER,
  FOCUS_SESSIONS_KEY,
  FOCUS_TIMER_KEY,
  type FocusSession,
  type FocusTimerState,
  dateKey,
  focusDayKey,
  formatCountdown,
  formatFocusDuration,
  getFocusTimerElapsedSeconds,
  isCompletedFocusSession,
  loadLocalFocusSessions,
  loadLocalFocusTimer,
  coerceFocusTimer,
  focusTimerPushKey,
  safeFocusSessions,
  sumFocusSecondsForDay,
  uid,
  playFocusChime,
  primeFocusAudio,
  coerceFocusChime,
  DEFAULT_FOCUS_CHIME,
  type FocusChimeId,
  playFocusCue,
  claimFocusCue,
  focusCueKey,
  coerceFocusCue,
  DEFAULT_FOCUS_CUES,
  type FocusCueId,
  type FocusCueSlot,
  claimFocusCompletion,
  autoSessionId,
  dedupeFocusSessions,
} from '@/lib/focusSessions';
import { type Recurrence, weekKeyOf, migrateEvents, resolveWeek, parseOccId } from '@/lib/recurrence';
import { gcalChipColors, resolveEventHex, type EventCardStyle } from '@/lib/gcalColor';
import { themePalette, type DarkPreset, type LightPreset } from '@/lib/settingsSync';

// ─── Types & Constants ────────────────────────────────────────────────────────
type IntervalMin   = 5 | 15 | 30 | 60;
type EventColor    = 'sage' | 'peach' | 'blue' | 'sand' | 'lilac' | 'rose' | 'teal' | 'lavender' | 'emerald' | 'coral' | string;
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
  allDay?: boolean;     // when true, this is an all-day event
  daysSpan?: number;    // for all-day events, the number of days it spans (1 to 7)
  gCalId?: string;
  gCalCalendarId?: string;
  gCalETag?: string;
  gCalHex?: string;     // exact colour Google renders this event in (foreign events only)
  gCalRecurSig?: string;
  lastSyncedAt?: number;
  updatedAt?: number;
  // Recurrence fields (see src/lib/recurrence.ts).
  weekKey?: string;
  recur?: Recurrence;
  exdates?: string[];
  deleted?: boolean;
  masterId?: string;
  occDate?: string;
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
  const [eventColorStyle, setEventColorStyle] = useState<EventCardStyle>('tinted');
  // The side window's own background theme, chosen separately from the main window.
  const [widgetDarkPreset, setWidgetDarkPreset] = useState<DarkPreset>('neutral-dark');
  const [widgetLightPreset, setWidgetLightPreset] = useState<LightPreset>('clean-white');
  const [timeFormat, setTimeFormat]   = useState<TimeFormat>('12h');
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(0);
  const [dayStartH, setDayStartH]       = useState(7);
  const [dayEndH, setDayEndH]           = useState(31);
  const [nowTick, setNowTick]           = useState(Date.now());
  const [isPinned, setIsPinned]         = useState(true);
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>([]);
  const [focusTimer, setFocusTimer]       = useState<FocusTimerState>(DEFAULT_FOCUS_TIMER);
  const [focusDayStartHour, setFocusDayStartHour] = useState(3);
  const focusChimeRef = useRef<FocusChimeId>(DEFAULT_FOCUS_CHIME);
  // Start / pause / resume cues, chosen in the main window's settings.
  const focusCuesRef = useRef<Record<FocusCueSlot, FocusCueId>>({ ...DEFAULT_FOCUS_CUES });
  const lastTimerJsonRef = useRef<string | null>(null);
  const timerHydratedRef = useRef(false);
  // Ignore stale server pulls briefly after a local change so they can't undo it.
  const lastLocalTimerChangeRef = useRef(0);
  const lastTimerPushKeyRef = useRef<string | null>(null);
  const [editingFocusMinutes, setEditingFocusMinutes] = useState(false);
  const [focusMinutesDraft, setFocusMinutesDraft] = useState('60');
  const [focusCollapsed, setFocusCollapsed] = useState(false);
  const focusCompleteRef = useRef(false);
  const [focusCelebrate, setFocusCelebrate] = useState(false);

  // ── Load Settings and initial events ───────────────────────────────────────
  useEffect(() => {
    // Fallback load local storage for events only
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { try { setEvents(migrateEvents(JSON.parse(saved) as PlannerData).events); } catch (_) {} }
    setFocusSessions(loadLocalFocusSessions());
    setFocusTimer(loadLocalFocusTimer());

    // Settings come from the shared backend so the widget always matches the main window.
    // Each loader is split into "apply this payload" + "go fetch it", so the live
    // stream and the fallback poll share exactly the same handling.
    const applySettings = (s: any) => {
      if (s && typeof s === 'object') {
        if (s.interval != null) setIntervalOpt(s.interval as IntervalMin);
        if (typeof s.darkMode === 'boolean') setDarkMode(s.darkMode);
        if (s.eventColorStyle) setEventColorStyle(s.eventColorStyle as EventCardStyle);
        if (s.widgetDarkPreset) setWidgetDarkPreset(s.widgetDarkPreset as DarkPreset);
        if (s.widgetLightPreset) setWidgetLightPreset(s.widgetLightPreset as LightPreset);
        if (s.timeFormat) setTimeFormat(s.timeFormat as TimeFormat);
        if (s.weekStartsOn != null) setWeekStartsOn(s.weekStartsOn as WeekStartsOn);
        if (s.dayStartH != null) setDayStartH(s.dayStartH);
        if (s.dayEndH != null) setDayEndH(s.dayEndH);
        if (s.focusDayStartHour != null) setFocusDayStartHour(Math.max(0, Math.min(23, Number(s.focusDayStartHour))));
        if (s.focusChime != null) focusChimeRef.current = coerceFocusChime(s.focusChime);
        if (s.focusCues && typeof s.focusCues === 'object') {
          const c = s.focusCues as Record<string, unknown>;
          focusCuesRef.current = {
            start: coerceFocusCue(c.start, 'start'),
            pause: coerceFocusCue(c.pause, 'pause'),
            resume: coerceFocusCue(c.resume, 'resume'),
          };
        }
      }
    };
    const loadSettings = () => {
      fetch('/api/settings')
        .then(r => r.json())
        .then(applySettings)
        .catch(err => console.error('Failed to sync widget settings:', err));
    };

    const applyEvents = (data: any) => {
      if (data && typeof data === 'object') {
        setEvents(migrateEvents(data as PlannerData).events);
      }
    };
    const loadEvents = () => {
      fetch('/api/events')
        .then(r => r.json())
        .then(applyEvents)
        .catch(err => console.error('Failed to sync widget database:', err));
    };

    const applyFocusSessions = (data: unknown) => {
      const sessions = safeFocusSessions(data);
      setFocusSessions(sessions);
      localStorage.setItem(FOCUS_SESSIONS_KEY, JSON.stringify(sessions));
    };
    const loadFocusSessions = () => {
      fetch('/api/focus-sessions')
        .then(r => r.json())
        .then(applyFocusSessions)
        .catch(err => console.error('Failed to sync focus sessions:', err));
    };

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === FOCUS_TIMER_KEY) setFocusTimer(loadLocalFocusTimer());
    };
    window.addEventListener('storage', handleStorage);

    // Shared running-timer state (see home.tsx for the echo-guard rationale).
    // `live` = arrived over the stream, so it can't be stale; only a poll needs
    // the grace window (see home.tsx for the full rationale).
    const applyTimerFromServer = (data: unknown, live = false) => {
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) { timerHydratedRef.current = true; return; }
      const json = JSON.stringify(coerceFocusTimer(data));
      timerHydratedRef.current = true;
      if (json === lastTimerJsonRef.current) return;
      if (!live && Date.now() - lastLocalTimerChangeRef.current < 4000) return;
      lastTimerJsonRef.current = json;
      lastTimerPushKeyRef.current = focusTimerPushKey(JSON.parse(json));
      setFocusTimer(JSON.parse(json));
    };
    const pullTimer = () => {
      fetch('/api/focus-timer')
        .then(r => r.json())
        .then(d => applyTimerFromServer(d))
        .catch(() => { timerHydratedRef.current = true; });
    };

    loadSettings();
    loadEvents();
    loadFocusSessions();
    pullTimer();
    // Live push: an edit in the main window lands here the moment it's saved.
    let dbStream: EventSource | null = null;
    try {
      dbStream = new EventSource('/api/db-stream');
      const on = (name: string, apply: (data: any) => void) =>
        dbStream!.addEventListener(name, (evt) => {
          try { apply(JSON.parse((evt as MessageEvent).data)); } catch (_) { /* ignore */ }
        });
      on('events', applyEvents);
      on('settings', applySettings);
      on('focus-sessions', applyFocusSessions);
    } catch (_) { /* fall back to the polls below */ }

    // Safety net only — the stream is what makes this feel instant.
    const settingsPollId = setInterval(loadSettings, 15000);
    const pollId = setInterval(loadEvents, 15000);
    const focusPollId = setInterval(loadFocusSessions, 15000);
    // Live push of the shared timer; the poll below is only a safety net for a
    // dropped stream (see home.tsx).
    let timerStream: EventSource | null = null;
    try {
      timerStream = new EventSource('/api/focus-timer/stream');
      timerStream.onmessage = (evt) => {
        try { applyTimerFromServer(JSON.parse(evt.data), true); } catch (_) { /* ignore */ }
      };
    } catch (_) { /* fall back to the poll */ }
    const timerPollId = setInterval(pullTimer, 1500);
    // Browsers block audio until the page sees a gesture; unlock on the first one
    // so the completion chime fires instantly instead of warming up first.
    // Stays attached rather than unhooking after the first gesture: the context
    // can be put back to sleep later, and a re-warm on every interaction is free.
    const unlockAudio = () => primeFocusAudio();
    unlockAudio();
    window.addEventListener('pointerdown', unlockAudio);
    window.addEventListener('keydown', unlockAudio);
    window.addEventListener('focus', unlockAudio);
    const clockId = setInterval(() => setNowTick(Date.now()), 1000);
    // Checkpoint a running session's elapsed time into durable state every few seconds
    // so closing the app mid-session never loses progress.
    const checkpointId = setInterval(() => {
      setFocusTimer(prev => (prev.isRunning && prev.lastStartedAt
        ? { ...prev, accumulatedSeconds: getFocusTimerElapsedSeconds(prev), lastStartedAt: new Date().toISOString() }
        : prev));
    }, 5000);

    return () => {
      window.removeEventListener('storage', handleStorage);
      clearInterval(settingsPollId);
      clearInterval(pollId);
      clearInterval(focusPollId);
      clearInterval(timerPollId);
      clearInterval(clockId);
      clearInterval(checkpointId);
      if (timerStream) timerStream.close();
      if (dbStream) dbStream.close();
      window.removeEventListener('pointerdown', unlockAudio);
      window.removeEventListener('keydown', unlockAudio);
      window.removeEventListener('focus', unlockAudio);
    };
  }, []);

  // ── Derived variables ──────────────────────────────────────────────────────
  const today = new Date(nowTick);
  const weekStart = startOfWeek(today, { weekStartsOn });
  const days = eachDayOfInterval({ start: weekStart, end: endOfWeek(today, { weekStartsOn }) });
  
  const dayStartMin = dayStartH * 60;
  const dayEndMin = dayEndH * 60;
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const nowOwnerDate = nowMin < dayStartMin ? subDays(today, 1) : today;
  const todayColIdx = days.findIndex(d => isSameDay(d, nowOwnerDate));

  // Resolve raw storage into the items visible in the current (real) week, so the
  // widget honours single-week items, recurring versions and per-week overrides.
  const viewedWeekKey = weekKeyOf(today, weekStartsOn);
  const weekEvents = useMemo(() => resolveWeek(events, viewedWeekKey), [events, viewedWeekKey]);

  const slots = generateSlots(interval, dayStartH, dayEndH);
  const sh = SLOT_H[interval];
  const totalH = slots.length * sh;
  // Identical resolution to the main window, so a card looks the same in both.
  const widgetTheme = themePalette(darkMode, widgetDarkPreset, widgetLightPreset);
  const chipColors = (ev: PlannerEvent) =>
    gcalChipColors(resolveEventHex(ev), { dark: darkMode, style: eventColorStyle, pageBg: widgetTheme.rootBg })
      ?? { bg: '#dcfce7', border: '#86efac', text: '#14532d', textMuted: '#2f6b45' };

  const normNowMin = normalizeMin(nowMin, dayStartH);
  const nowInView = normNowMin >= dayStartMin && normNowMin <= dayEndMin;
  const focusElapsedSeconds = getFocusTimerElapsedSeconds(focusTimer, nowTick);
  const focusRemainingSeconds = Math.max(0, focusTimer.plannedSeconds - focusElapsedSeconds);
  // "Today" for focus stats respects the configurable day-start hour (e.g. before
  // 3 AM still counts as the previous day).
  const focusTodayKey = focusDayKey(today, focusDayStartHour);
  const focusTodayMidnight = new Date(`${focusTodayKey}T00:00:00`);
  const todayFocusSeconds = sumFocusSecondsForDay(focusSessions, focusTodayMidnight, focusDayStartHour)
    + (focusTimer.sessionStartedAt && focusDayKey(focusTimer.sessionStartedAt, focusDayStartHour) === focusTodayKey ? focusElapsedSeconds : 0);
  const todayFocusSessions = focusSessions.filter(session => focusDayKey(session.endedAt, focusDayStartHour) === focusTodayKey && isCompletedFocusSession(session)).length;
  const focusProgressPct = Math.min(100, Math.max(0, (focusElapsedSeconds / focusTimer.plannedSeconds) * 100));

  // An event "spans the day boundary" when it starts before the configured day-start
  // hour and ends after it (e.g. sleep from 1:15am to 9:45am with a 7am day cutoff) —
  // it renders as a linked tail (in its own day) + head (in the next day) segment.
  const isBoundarySpanning = useCallback((ev: PlannerEvent) => {
    const s = normalizeMin(timeToMin(ev.startTime), dayStartH);
    let e = normalizeMin(timeToMin(ev.endTime), dayStartH);
    if (e <= s) e += 1440;
    return s < dayStartMin + 1440 && e > dayStartMin + 1440;
  }, [dayStartH, dayStartMin]);

  const colEvents = useMemo(() => {
    if (todayColIdx === -1) return [];
    const items: Array<{ ev: PlannerEvent; key: string; startMin: number; endMin: number; segKind: 'normal' | 'tail' | 'head' }> = [];
    for (const ev of Object.values(weekEvents)) {
      if (ev.allDay) continue; // Skip all-day events in the timeline scroll area
      if (isBoundarySpanning(ev)) {
        const s = normalizeMin(timeToMin(ev.startTime), dayStartH);
        let e = normalizeMin(timeToMin(ev.endTime), dayStartH);
        if (e <= s) e += 1440;
        if (ev.dayIndex === todayColIdx) {
          items.push({ ev, key: ev.id, startMin: s, endMin: dayStartMin + 1440, segKind: 'tail' });
        }
        if ((ev.dayIndex + 1) % 7 === todayColIdx) {
          items.push({ ev, key: `${ev.id}__head`, startMin: dayStartMin, endMin: e - 1440, segKind: 'head' });
        }
        continue;
      }
      if (ev.dayIndex === todayColIdx) {
        items.push({
          ev, key: ev.id, segKind: 'normal',
          startMin: normalizeMin(timeToMin(ev.startTime), dayStartH),
          endMin: normalizeMin(timeToMin(ev.endTime), dayStartH),
        });
      }
    }
    return items;
  }, [weekEvents, todayColIdx, isBoundarySpanning, dayStartMin, dayEndMin, dayStartH]);

  const layout = useMemo(() => {
    const layoutInput = colEvents.map(item => ({
      id: item.key,
      startMin: item.startMin,
      endMin: item.endMin,
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

  // On first launch, act as though Go Live was pressed.
  //
  // The centering effect above isn't enough on its own: it can run before the
  // day's events have arrived and the column has its real height, and the scroll
  // it performs fires the scroll handler, which reads as "the user scrolled away"
  // and switches live-tracking off. So re-assert it a few times over the first
  // second, then leave it alone.
  const didInitialLive = useRef(false);
  useEffect(() => {
    if (didInitialLive.current) return;
    const container = scrollContainerRef.current;
    if (!container || slots.length === 0) return;
    didInitialLive.current = true;

    const timers = [120, 400, 900].map(delay =>
      window.setTimeout(() => {
        if (scrollContainerRef.current?.clientHeight) scrollToLive();
      }, delay),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [slots.length, events]);

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

  const persistFocusSessions = useCallback((sessions: FocusSession[]) => {
    localStorage.setItem(FOCUS_SESSIONS_KEY, JSON.stringify(sessions));
    fetch('/api/focus-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessions),
    }).catch(err => console.error('Failed to save focus sessions:', err));
  }, []);

  const completeFocusSession = useCallback((durationSeconds?: number, auto = false) => {
    const duration = Math.floor(durationSeconds ?? getFocusTimerElapsedSeconds(focusTimer));
    if (duration <= 0) {
      setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
      return;
    }

    const endedAt = new Date();
    const startedAt = focusTimer.sessionStartedAt
      ? new Date(focusTimer.sessionStartedAt)
      : new Date(endedAt.getTime() - duration * 1000);

    const session: FocusSession = {
      // Deterministic id for auto-completions so this window and the main window
      // (both counting down the same shared timer) log ONE session, not two.
      id: auto ? autoSessionId(focusTimer.sessionStartedAt, focusTimer.plannedSeconds) : uid(),
      startedAt: startedAt.toISOString(),
      endedAt: endedAt.toISOString(),
      durationSeconds: duration,
      plannedSeconds: focusTimer.plannedSeconds,
    };

    setFocusSessions(prev => {
      const next = dedupeFocusSessions([session, ...prev]).slice(0, 1000);
      persistFocusSessions(next);
      return next;
    });
    setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
  }, [focusTimer, persistFocusSessions]);

  useEffect(() => {
    localStorage.setItem(FOCUS_TIMER_KEY, JSON.stringify(focusTimer));
    // Don't push to the backend until we've hydrated from it (avoid clobbering a live
    // session owned by another window before our first pull).
    if (!timerHydratedRef.current) return;
    const json = JSON.stringify(coerceFocusTimer(focusTimer));
    if (json === lastTimerJsonRef.current) return;
    // Running-session checkpoints carry no new information; pushing them would
    // stomp a start/pause made elsewhere (main window, system-wide hotkey).
    const pushKey = focusTimerPushKey(coerceFocusTimer(focusTimer));
    if (pushKey === lastTimerPushKeyRef.current) return;
    lastTimerPushKeyRef.current = pushKey;
    lastTimerJsonRef.current = json;
    lastLocalTimerChangeRef.current = Date.now();
    fetch('/api/focus-timer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
    }).catch(() => {});
  }, [focusTimer]);

  useEffect(() => {
    if (!editingFocusMinutes) {
      setFocusMinutesDraft(String(Math.max(1, Math.round(focusTimer.plannedSeconds / 60))));
    }
  }, [editingFocusMinutes, focusTimer.plannedSeconds]);

  useEffect(() => {
    if (focusTimer.isRunning && focusRemainingSeconds <= 0 && !focusCompleteRef.current) {
      focusCompleteRef.current = true;
      if (claimFocusCompletion()) {
        setFocusCelebrate(true);
        window.setTimeout(() => setFocusCelebrate(false), 2600);
      }
      // Claimed through the server, not localStorage — see home.tsx.
      claimFocusCue(
        `complete|${focusTimer.sessionStartedAt ?? ''}|${focusTimer.plannedSeconds}`,
        () => playFocusChime(focusChimeRef.current),
      );
      completeFocusSession(focusTimer.plannedSeconds, true);
    } else if (!focusTimer.isRunning || focusRemainingSeconds > 0) {
      focusCompleteRef.current = false;
    }
  }, [completeFocusSession, focusRemainingSeconds, focusTimer.isRunning, focusTimer.plannedSeconds]);

  // Start / pause / resume cues. Driven off the timer state rather than the
  // buttons, so a toggle from the main window or the hotkey sounds too.
  const prevRunningRef = useRef<boolean | null>(null);
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const running = focusTimer.isRunning;
    const session = focusTimer.sessionStartedAt ?? null;
    const prevRunning = prevRunningRef.current;
    const prevSession = prevSessionRef.current;
    prevRunningRef.current = running;
    prevSessionRef.current = session;
    if (prevRunning === null) return; // first render — nothing to compare against

    let slot: FocusCueSlot | null = null;
    if (running && !prevRunning) {
      slot = session && session === prevSession ? 'resume' : 'start';
    } else if (!running && prevRunning) {
      // Hitting zero is a completion, not a pause — the chime covers that.
      if (focusRemainingSeconds > 0) slot = 'pause';
    }
    if (!slot) return;

    // Fold the panel away while running and open it back up when paused, no
    // matter where the toggle came from — this window's button, the main window,
    // or the system-wide hotkey.
    setFocusCollapsed(slot !== 'pause');

    const cue = focusCuesRef.current[slot];
    if (cue === 'none') return;
    claimFocusCue(focusCueKey(slot, focusTimer), () => playFocusCue(cue));
  }, [focusTimer, focusRemainingSeconds]);

  const startFocus = () => {
    const startedAt = new Date().toISOString();
    setFocusCollapsed(true);
    setFocusTimer(prev => ({
      ...prev,
      isRunning: true,
      lastStartedAt: startedAt,
      sessionStartedAt: prev.sessionStartedAt ?? startedAt,
      lastPausedAt: null,
    }));
  };

  const pauseFocus = () => {
    setFocusTimer(prev => ({
      ...prev,
      accumulatedSeconds: getFocusTimerElapsedSeconds(prev),
      isRunning: false,
      lastStartedAt: null,
      lastPausedAt: new Date().toISOString(),
    }));
  };

  const resetFocus = () => {
    setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
  };

  const stopFocus = () => {
    completeFocusSession(focusElapsedSeconds);
  };

  const setFocusMinutes = (minutes: number) => {
    const safeMinutes = Math.max(1, Math.floor(minutes));
    setFocusTimer(prev => ({
      ...prev,
      plannedSeconds: safeMinutes * 60,
    }));
  };

  const adjustFocusMinutes = (deltaMinutes: number) => {
    const currentMinutes = Math.max(1, Math.round(focusTimer.plannedSeconds / 60));
    if (deltaMinutes > 0) {
      setFocusMinutes(Math.max(5, Math.ceil((currentMinutes + 1) / 5) * 5));
    } else {
      setFocusMinutes(Math.max(5, Math.floor((currentMinutes - 1) / 5) * 5));
    }
  };

  const commitFocusMinutesDraft = () => {
    const parsed = Number(focusMinutesDraft);
    if (Number.isFinite(parsed) && parsed > 0) {
      setFocusMinutes(parsed);
    } else {
      setFocusMinutesDraft(String(Math.max(1, Math.round(focusTimer.plannedSeconds / 60))));
    }
    setEditingFocusMinutes(false);
  };

  const toggleEventCompleted = (id: string) => {
    const todayDate = new Date();
    const dateStr = format(todayDate, 'yyyy-MM-dd');
    // `id` may be an occurrence id ("master::date"); completion lives on the master.
    const { masterId } = parseOccId(id);
    setEvents(prev => {
      const ev = prev[masterId];
      if (!ev) return prev;
      const completedDates = ev.completedDates || [];
      const updatedDates = completedDates.includes(dateStr)
        ? completedDates.filter(d => d !== dateStr)
        : [...completedDates, dateStr];
      const updatedEvents = { ...prev, [masterId]: { ...ev, completedDates: updatedDates } };
      
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
  const surfaceBg  = darkMode ? widgetTheme.surfaceBg : 'rgba(255,255,255,0.60)';
  const surfaceBdr = widgetTheme.surfaceBdr;
  const menuText   = darkMode ? '#e8e8e8' : '#1a1a1a';
  const menuSub    = darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';

  return (
    <div className={`h-screen bg-background text-foreground flex flex-col font-sans select-none overflow-hidden ${darkMode ? 'dark' : ''}`} style={{ background: widgetTheme.rootBg }}>
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

        /* ── Window header ──────────────────────────────────────────────── */
        .wgt-header-btn {
          width: 26px;
          height: 26px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 8px;
          color: rgba(0,0,0,0.45);
          background: transparent;
          transition: background-color 140ms ease, color 140ms ease, transform 140ms ease;
        }
        .dark .wgt-header-btn { color: rgba(255,255,255,0.50); }
        .wgt-header-btn:hover {
          background: rgba(0,0,0,0.07);
          color: rgba(0,0,0,0.85);
        }
        .dark .wgt-header-btn:hover {
          background: rgba(255,255,255,0.10);
          color: rgba(255,255,255,0.95);
        }
        .wgt-header-btn:active { transform: scale(0.92); }

        /* Pinned is a state, so it reads as a filled pill rather than just a
           rotated icon — much easier to see at a glance. */
        .wgt-header-btn.is-active,
        .wgt-header-btn.is-active:hover {
          background: rgba(59,130,246,0.16);
          color: #3b82f6;
        }
        .dark .wgt-header-btn.is-active,
        .dark .wgt-header-btn.is-active:hover {
          background: rgba(96,165,250,0.20);
          color: #60a5fa;
        }

        .wgt-header-btn.is-close:hover {
          background: #e5484d;
          color: #ffffff;
        }
      `}</style>
      {/* Drag handle header for pywebview */}
      <header
        onMouseDown={handleHeaderMouseDown}
        className="pywebview-drag sticky top-0 z-30 backdrop-blur-xl flex items-center justify-between pl-3 pr-2 h-[46px] cursor-move"
        style={{
          // A soft top-down wash with a hairline rule, instead of a flat panel
          // and a hard border — that combination is what read as "old app".
          background: darkMode
            ? 'linear-gradient(180deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0.025) 100%)'
            : 'linear-gradient(180deg, rgba(255,255,255,0.88) 0%, rgba(255,255,255,0.58) 100%)',
          boxShadow: darkMode
            ? 'inset 0 -1px 0 rgba(255,255,255,0.07), 0 1px 12px rgba(0,0,0,0.22)'
            : 'inset 0 -1px 0 rgba(0,0,0,0.07), 0 1px 12px rgba(0,0,0,0.05)',
        }}
      >
        <div className="flex items-center gap-2.5 pointer-events-none min-w-0">
          <div
            className="w-[26px] h-[26px] rounded-lg flex items-center justify-center flex-shrink-0"
            style={{
              background: darkMode ? 'rgba(96,165,250,0.16)' : 'rgba(59,130,246,0.10)',
              color: darkMode ? '#60a5fa' : '#3b82f6',
            }}
          >
            <Calendar size={14} />
          </div>
          {/* Date and clock on their own lines: the date is what you read, the
              time is glanceable detail. One cramped row of both, separated by a
              bullet, is the thing that looked dated. */}
          <div className="flex flex-col min-w-0 leading-none">
            <span className="text-[12px] font-semibold tracking-tight truncate" style={{ color: menuText }}>
              {format(today, 'EEEE, MMMM d')}
            </span>
            <span className="text-[10.5px] font-medium tabular-nums mt-[3px]" style={{ color: menuSub }}>
              {format(today, 'h:mm:ss a')}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-0.5 pointer-events-auto flex-shrink-0">
          <button
            onClick={togglePin}
            className={`wgt-header-btn ${isPinned ? 'is-active' : ''}`}
            title={isPinned ? 'Unpin widget' : 'Keep widget on top'}
          >
            <Pin size={13} style={{ transform: isPinned ? 'none' : 'rotate(45deg)' }} />
          </button>
          <button onClick={openMainSite} className="wgt-header-btn" title="Open the full planner">
            <ExternalLink size={13} />
          </button>
          <button onClick={minimizeWidget} className="wgt-header-btn" title="Minimize widget">
            <Minus size={14} />
          </button>
          <button onClick={closeWidget} className="wgt-header-btn is-close" title="Close widget">
            <X size={14} />
          </button>
        </div>
      </header>

      <section className={`flex-shrink-0 px-3 ${focusCollapsed ? 'py-2' : 'py-3'} border-b border-border/50 transition-all duration-200`} style={{ background: darkMode ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.38)' }}>
        <div className="rounded-lg overflow-hidden" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
          <div className={`${focusCollapsed ? 'px-3 py-2' : 'px-3 pt-3 pb-2'} flex items-center justify-between gap-2`}>
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: darkMode ? 'rgba(59,130,246,0.18)' : 'rgba(59,130,246,0.10)', color: '#60a5fa' }}>
                <Clock size={14} />
              </div>
              <div className="min-w-0">
                <div className="text-[11px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Focus Session</div>
                <div className="text-[10px] tabular-nums truncate" style={{ color: menuSub }}>
                  Today {formatFocusDuration(todayFocusSeconds)} - {todayFocusSessions} done
                </div>
              </div>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <motion.div
                className={`${focusCollapsed ? 'text-[18px]' : 'text-[28px]'} leading-none font-semibold tabular-nums tracking-normal transition-all duration-200`}
                style={{ color: focusCelebrate ? '#4ade80' : menuText }}
                animate={focusCelebrate
                  ? { scale: [1, 1.16, 1, 1.08, 1], textShadow: ['0 0 0px rgba(74,222,128,0)', '0 0 18px rgba(74,222,128,0.75)', '0 0 0px rgba(74,222,128,0)'] }
                  : { scale: 1 }}
                transition={focusCelebrate ? { duration: 1.5, ease: 'easeInOut' } : { duration: 0.3 }}
              >
                {formatCountdown(focusRemainingSeconds)}
              </motion.div>
              <button
                onClick={() => setFocusCollapsed(v => !v)}
                className="w-7 h-7 rounded-md flex items-center justify-center transition-all active:scale-[0.96]"
                title={focusCollapsed ? 'Expand focus session' : 'Minimize focus session'}
                style={{
                  background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                  border: `1px solid ${surfaceBdr}`,
                  color: menuSub,
                }}
              >
                {focusCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
              </button>
            </div>
          </div>

          {!focusCollapsed && (
          <>
          <div className="h-1 mx-3 rounded-full overflow-hidden" style={{ background: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{
                width: `${focusProgressPct}%`,
                background: focusTimer.isRunning ? '#60a5fa' : darkMode ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.28)',
              }}
            />
          </div>

          <div className="px-3 py-2 flex items-center gap-2">
            <button
              onClick={() => adjustFocusMinutes(-5)}
              className="w-8 h-8 rounded-md flex items-center justify-center transition-all active:scale-[0.96]"
              title="Decrease focus duration by 5 minutes"
              style={{
                background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                border: `1px solid ${surfaceBdr}`,
                color: menuSub,
              }}
            >
              <Minus size={13} />
            </button>
            <div
              className="flex-1 h-8 rounded-md flex items-center justify-center px-2"
              style={{
                background: darkMode ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.08)',
                border: '1px solid rgba(96,165,250,0.24)',
                color: menuText,
              }}
            >
              {editingFocusMinutes ? (
                <input
                  autoFocus
                  value={focusMinutesDraft}
                  onChange={(e) => setFocusMinutesDraft(e.target.value.replace(/[^\d]/g, ''))}
                  onBlur={commitFocusMinutesDraft}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitFocusMinutesDraft();
                    if (e.key === 'Escape') {
                      setFocusMinutesDraft(String(Math.max(1, Math.round(focusTimer.plannedSeconds / 60))));
                      setEditingFocusMinutes(false);
                    }
                  }}
                  className="w-full bg-transparent outline-none text-center text-sm font-semibold tabular-nums"
                  style={{ color: menuText }}
                />
              ) : (
                <button
                  onClick={() => setEditingFocusMinutes(true)}
                  className="w-full h-full text-sm font-semibold tabular-nums cursor-text"
                  title="Click to type a focus duration"
                >
                  {Math.max(1, Math.round(focusTimer.plannedSeconds / 60))} min
                </button>
              )}
            </div>
            <button
              onClick={() => adjustFocusMinutes(5)}
              className="w-8 h-8 rounded-md flex items-center justify-center transition-all active:scale-[0.96]"
              title="Increase focus duration by 5 minutes"
              style={{
                background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                border: `1px solid ${surfaceBdr}`,
                color: menuSub,
              }}
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="px-3 pb-3 grid grid-cols-4 gap-1.5">
            <button
              onClick={focusTimer.isRunning ? pauseFocus : startFocus}
              className="col-span-2 h-8 rounded-md flex items-center justify-center gap-1.5 text-xs font-semibold transition-all active:scale-[0.98]"
              style={{
                background: focusTimer.isRunning ? 'rgba(245,158,11,0.18)' : '#2563eb',
                border: `1px solid ${focusTimer.isRunning ? 'rgba(245,158,11,0.35)' : '#2563eb'}`,
                color: focusTimer.isRunning ? '#fbbf24' : '#ffffff',
              }}
            >
              {focusTimer.isRunning ? <Pause size={13} /> : <Play size={13} />}
              {focusTimer.isRunning ? 'Pause' : focusElapsedSeconds > 0 ? 'Resume' : 'Start'}
            </button>
            <button
              onClick={resetFocus}
              disabled={focusElapsedSeconds <= 0}
              className="h-8 rounded-md flex items-center justify-center transition-all active:scale-[0.98]"
              title="Reset focus timer"
              style={{
                background: 'transparent',
                border: `1px solid ${surfaceBdr}`,
                color: menuSub,
                opacity: focusElapsedSeconds <= 0 ? 0.4 : 1,
              }}
            >
              <RotateCcw size={13} />
            </button>
            <button
              onClick={stopFocus}
              disabled={focusElapsedSeconds <= 0}
              className="h-8 rounded-md flex items-center justify-center transition-all active:scale-[0.98]"
              title="Stop and log focus time"
              style={{
                background: focusElapsedSeconds > 0 ? (darkMode ? 'rgba(34,197,94,0.14)' : 'rgba(34,197,94,0.10)') : 'transparent',
                border: `1px solid ${focusElapsedSeconds > 0 ? 'rgba(34,197,94,0.35)' : surfaceBdr}`,
                color: focusElapsedSeconds > 0 ? '#4ade80' : menuSub,
                opacity: focusElapsedSeconds <= 0 ? 0.4 : 1,
              }}
            >
              <Square size={12} />
            </button>
          </div>
          </>
          )}
        </div>
      </section>

      {/* Timeline Column */}
      <main ref={scrollContainerRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col no-scrollbar">
        {/* All-Day Events in Widget (Scrollable with timeline) */}
        {todayColIdx !== -1 && (() => {
          const todayAllDay = Object.values(weekEvents).filter(ev => {
            if (!ev.allDay || ev.deleted) return false;
            const start = ev.dayIndex;
            const end = start + (ev.daysSpan || 1);
            return todayColIdx >= start && todayColIdx < end;
          });
          if (todayAllDay.length === 0) return null;
          return (
            <div className="flex border-b border-border/50 flex-shrink-0" style={{ background: darkMode ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)' }}>
              {/* Axis spacer */}
              <div className="flex-shrink-0 border-r border-border/50 flex items-center justify-center p-1" style={{ width: 62 }}>
                <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50 text-center">All Day</span>
              </div>
              {/* Events list */}
              <div className="flex-1 p-2 flex flex-col gap-1">
                {todayAllDay.map(ev => {
                  const { bg, border, text, textMuted } = chipColors(ev);
                  const dateStr = format(today, 'yyyy-MM-dd');
                  const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(dateStr) ?? false);
                  return (
                    <div
                      key={ev.id}
                      className="px-2 py-1 rounded-md border text-[11px] font-semibold flex items-center gap-1.5 shadow-sm"
                      style={{ backgroundColor: bg, borderColor: border, color: text }}
                    >
                      {!ev.noCheckbox && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleEventCompleted(ev.id);
                          }}
                          className="flex-shrink-0 w-3 h-3 rounded-full border flex items-center justify-center cursor-pointer"
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
                      <span className={`truncate flex-1 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                        {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })()}

        {/* Timeline Grid (Axis + Grid Area) */}
        <div className="flex flex-row relative flex-shrink-0" style={{ height: totalH }}>
          {/* Time axis */}
          <div className="flex-shrink-0 border-r border-border/50" style={{ width: 62, background: darkMode ? 'rgba(0,0,0,0.15)' : 'rgba(255,255,255,0.30)' }}>
            <div className="relative" style={{ height: totalH }}>
              {slots.map((time, i) => {
                const isHour = time.endsWith(':00');
                return (
                  <div key={time} className="absolute w-full flex justify-center items-start" style={{ top: i * sh, height: sh }}>
                    <span className={`leading-none px-1 tabular-nums ${isHour ? 'mt-1 text-[12px] font-semibold text-muted-foreground' : 'mt-1 text-[7.5px] text-muted-foreground/30'}`}>
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
            const nowAccent     = darkMode ? '#ff6b6b' : '#e5484d';
            const nowAccentSoft = darkMode ? 'rgba(255,107,107,0.22)' : 'rgba(229,72,77,0.18)';
            return (
              <div className="absolute left-0 right-0 z-30 pointer-events-none" style={{ top: lineTop, height: 0 }}>
                {/* Soft glow behind the line so it reads without shouting */}
                <div
                  className="absolute left-0 right-0"
                  style={{ height: 12, top: -6, background: `linear-gradient(to bottom, transparent, ${nowAccentSoft}, transparent)` }}
                />
                {/* Pulsing dot with a matching halo */}
                <motion.div
                  className="absolute -left-[2px]"
                  style={{ width: 9, height: 9, borderRadius: '50%', background: nowAccent, top: -3.5, boxShadow: `0 0 0 3px ${nowAccentSoft}` }}
                  animate={{ opacity: [0.65, 1, 0.65], scale: [0.92, 1.08, 0.92] }}
                  transition={{ duration: 2.6, repeat: Infinity, ease: 'easeInOut' }}
                />
                {/* Hairline that fades out toward the right edge */}
                <div
                  className="absolute left-0 right-0"
                  style={{ height: 1.5, background: `linear-gradient(to right, ${nowAccent}, ${nowAccent} 65%, ${nowAccentSoft})`, opacity: 0.9 }}
                />
                {/* Live time chip */}
                <div
                  className="absolute text-[9px] font-bold tabular-nums px-1.5 py-[1px] rounded-full whitespace-nowrap"
                  style={{ right: 3, top: -8, background: nowAccent, color: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.25)', letterSpacing: '0.02em' }}
                >
                  {formatTimeLabel(nowMin, timeFormat)}
                </div>
              </div>
            );
          })()}

          {/* Events list */}
          {colEvents.map(item => {
            const { ev, key: itemKey, segKind } = item;
            const top = minToY(item.startMin, interval, dayStartH);
            const height = Math.max(sh, minToY(item.endMin, interval, dayStartH) - top);
            const { bg, border, text, textMuted } = chipColors(ev);
            // Live/duration status always reflects the event's true full start–end, not just this segment.
            const fullStartMin = timeToMin(ev.startTime);
            const fullEndMin   = timeToMin(ev.endTime);
            const spansBoundary = fullStartMin < dayStartMin && fullEndMin >= dayStartMin;
            // "Live" is scoped to this segment's own on-screen range (each segment lives in a
            // different day column, so at most one of tail/head is ever the active one).
            const isLive       = normNowMin >= item.startMin && normNowMin < item.endMin;
            const minutesLeft  = Math.max(0, segKind === 'tail'
              ? fullEndMin + 1440 - normNowMin
              : segKind === 'head'
                ? fullEndMin - normNowMin
                : normalizeMin(fullEndMin, dayStartH) - normNowMin);
            const durationMin  = Math.max(0, spansBoundary
              ? fullEndMin - fullStartMin
              : normalizeMin(fullEndMin, dayStartH) - normalizeMin(fullStartMin, dayStartH));
            const durationLabel = durationMin < 60
              ? `${durationMin} minute${durationMin === 1 ? '' : 's'}`
              : durationMin % 60 === 0
                ? `${durationMin / 60} hour${durationMin / 60 === 1 ? '' : 's'}`
                : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`;

            const { col, numCols } = layout.get(itemKey) ?? { col: 0, numCols: 1 };
            const colW = 100 / numCols;
            const leftPct = col * colW;
            const rightPct = 100 - (col + 1) * colW;
            const EDGE = 3;

            const todayDate = new Date();
            const dateStr = format(todayDate, 'yyyy-MM-dd');
            const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(dateStr) ?? false);

            return (
              <div
                key={itemKey}
                className={`absolute border shadow-sm transition-shadow duration-150 z-10 ${segKind === 'tail' ? 'rounded-t-lg' : segKind === 'head' ? 'rounded-b-lg' : 'rounded-lg'}`}
                style={{
                  top, height,
                  left:  `calc(${leftPct}% + ${EDGE}px)`,
                  right: `calc(${rightPct}% + ${EDGE}px)`,
                  backgroundColor: bg,
                  borderColor: border,
                  borderBottomStyle: segKind === 'tail' ? 'dashed' : 'solid',
                  borderTopStyle: segKind === 'head' ? 'dashed' : 'solid',
                  color: text,
                }}
              >
                {segKind === 'head' && (
                  <div className="absolute top-0 left-0 right-0 flex items-center justify-center pointer-events-none" style={{ height: 9 }} title={`Continues from ${formatTimeLabel(fullStartMin, timeFormat)} the night before`}>
                    <span style={{ fontSize: 8, lineHeight: 1, opacity: 0.55, color: text }}>⌃ continued</span>
                  </div>
                )}
                <div className="absolute inset-0 px-2 py-1.5 flex flex-col overflow-hidden">
                  {/* Top time label */}
                  <span className="text-[10px] mb-0.5 font-semibold whitespace-nowrap tabular-nums flex-shrink-0 flex items-center gap-1 opacity-90" style={{ color: textMuted }}>
                    {formatTimeLabel(fullStartMin, timeFormat)} – {formatTimeLabel(fullEndMin, timeFormat)}
                    {isLive ? (
                      <span className="inline-flex items-center gap-0.5" style={{ opacity: 1, color: darkMode ? '#ff8a8a' : '#dc2626' }}>
                        <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: darkMode ? '#ff8a8a' : '#dc2626' }} />
                        {minutesLeft}m left
                      </span>
                    ) : (
                      <span>({durationLabel})</span>
                    )}
                  </span>
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
                    <p className={`text-[13px] font-semibold leading-tight break-words line-clamp-4 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                      {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic' }}>Untitled</span>}
                    </p>
                  </div>
                  {height >= sh * 1.5 && (
                    <span className="text-[10.5px] mt-0.5 font-medium whitespace-nowrap tabular-nums pl-5 flex-shrink-0 flex items-center gap-1" style={{ color: textMuted }}>
                      {formatTimeLabel(fullStartMin, timeFormat)} – {formatTimeLabel(fullEndMin, timeFormat)}
                      {isLive ? (
                        <span className="inline-flex items-center gap-0.5" style={{ opacity: 1, color: darkMode ? '#ff8a8a' : '#dc2626' }}>
                          <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: darkMode ? '#ff8a8a' : '#dc2626' }} />
                          {minutesLeft}m left
                        </span>
                      ) : (
                        <span>({durationLabel})</span>
                      )}
                    </span>
                  )}
                </div>
                {segKind === 'tail' && (
                  <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center pointer-events-none" style={{ height: 9 }} title={`Continues until ${formatTimeLabel(fullEndMin, timeFormat)}`}>
                    <span style={{ fontSize: 8, lineHeight: 1, opacity: 0.55, color: text }}>continued ⌄</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
