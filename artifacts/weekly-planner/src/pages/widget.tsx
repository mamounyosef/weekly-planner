import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import {
  format,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  isToday,
  addDays,
  isSameDay,
  differenceInDays,
  startOfDay,
} from 'date-fns';
import { X, Calendar, Clock, Minus, ExternalLink, Pin, Play, Pause, RotateCcw, Square, Plus, ChevronUp, ChevronDown, CheckCircle2, Circle, Moon, ListTodo, MoreHorizontal, CheckSquare } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  resolveWeekTasks,
  toggleTaskDone as toggleTaskDoneHelper,
  isTaskDone,
  coerceTasks,
  TASKS_STORAGE_KEY,
  type TaskData,
} from '@/lib/tasks';
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
  getFocusTimerUncreditedSeconds,
  loggableSessionSeconds,
  checkpointFocusTimer,
  pauseFocusTimer,
  isCompletedFocusSession,
  loadLocalFocusSessions,
  loadLocalFocusTimer,
  coerceFocusTimer,
  focusTimerPushKey,
  focusTimerIdentity,
  focusTimerTransitionKey,
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
  isFocusCueFresh,
  coerceFocusCue,
  DEFAULT_FOCUS_CUES,
  type FocusCueId,
  type FocusCueSlot,
  claimFocusCompletion,
  autoSessionId,
  dedupeFocusSessions,
  FOCUS_HEARTBEAT_INTERVAL_MS,
  MIN_RECOVERED_SESSION_SECONDS,
  focusRecoveryFor,
  recoveredSessionId,
  safeFocusHeartbeat,
} from '@/lib/focusSessions';
import { type Recurrence, weekKeyOf, migrateEvents, resolveWeek, parseOccId, parseDate, getEventWeekOverlap } from '@/lib/recurrence';
import { gcalChipColors, resolveEventHex, type EventCardStyle } from '@/lib/gcalColor';
import { ACCENT_BAR_W } from '@/components/EventCardPreview';
import { DEFAULT_CATEGORIES, resolveEventColor, coerceCategories, type EventCategory } from '@/lib/categories';
import { themePalette, subscribeSettingsChange, type DarkPreset, type LightPreset, type TaskCheckboxShape } from '@/lib/settingsSync';
import { fetchDeviceSettings, loadDeviceSettingsLocal, subscribeDeviceSettings } from '@/lib/deviceSettings';
import { matchesCombo, formatCombo, DEFAULT_SHORTCUTS, coerceShortcuts, type ShortcutMap } from '@/lib/shortcuts';
import {
  coercePrayerSettings,
  DEFAULT_PRAYER_SETTINGS,
  prayerDateKey,
  type PrayerOccurrence,
  type PrayerSettings,
} from '@/lib/prayerTimes';
import {
  coerceHardwareSettings,
  DEFAULT_HARDWARE_SETTINGS,
  useHardwareController,
  type HardwareSettings,
} from '@/lib/hardwareController';
import { usePrayerTimes } from '@/lib/usePrayerTimes';

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
  categoryId?: string;
  completedDates?: string[];
  noCheckbox?: boolean; // when true, this event has no completion checkbox
  noDuration?: boolean; // when true, this event has no duration (point in time / deadline)
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
  locked?: boolean;
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

function formatCompactRange(startMin: number, endMin: number, fmt: TimeFormat = '12h'): string {
  const normS = ((startMin % 1440) + 1440) % 1440;
  const normE = ((endMin % 1440) + 1440) % 1440;
  if (fmt === '24h') {
    const sh = Math.floor(normS / 60), sm = normS % 60;
    const eh = Math.floor(normE / 60), em = normE % 60;
    const sStr = sm === 0 ? String(sh).padStart(2, '0') : `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`;
    const eStr = em === 0 ? String(eh).padStart(2, '0') : `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`;
    return `${sStr}–${eStr}`;
  }
  const sh = Math.floor(normS / 60), sm = normS % 60;
  const eh = Math.floor(normE / 60), em = normE % 60;
  const sAmpm = sh >= 12 ? 'pm' : 'am';
  const eAmpm = eh >= 12 ? 'pm' : 'am';
  const sh12 = sh % 12 || 12;
  const eh12 = eh % 12 || 12;
  const sStr = sm === 0 ? `${sh12}` : `${sh12}:${String(sm).padStart(2, '0')}`;
  const eStr = em === 0 ? `${eh12}` : `${eh12}:${String(em).padStart(2, '0')}`;
  if (sAmpm === eAmpm) return `${sStr}–${eStr}${eAmpm}`;
  return `${sStr}${sAmpm}–${eStr}${eAmpm}`;
}

function formatSlotLabel(slot: string, fmt: TimeFormat): string {
  if (fmt === '24h') return slot;
  const [hStr, mStr] = slot.split(':');
  const h = parseInt(hStr, 10);
  const m = parseInt(mStr, 10);
  return formatTimeLabel(h * 60 + m, fmt);
}

function formatTimeLeft(mins: number): string {
  if (mins <= 0) return '0m left';
  if (mins < 60) return `${mins}m left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h left` : `${h}h ${m}m left`;
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
  /** Serialized form of the sessions on screen — see `applyFocusSessions`. */
  const lastFocusSessionsJsonRef = useRef<string | null>(null);
  /** True once the sessions have been read from the server at least once. */
  const [focusSessionsHydrated, setFocusSessionsHydrated] = useState(false);
  const [focusTimer, setFocusTimer]       = useState<FocusTimerState>(() => loadLocalFocusTimer());
  const [focusDayStartHour, setFocusDayStartHour] = useState(3);
  const [hardware, setHardware] = useState<HardwareSettings>(DEFAULT_HARDWARE_SETTINGS);
  const focusChimeRef = useRef<FocusChimeId>(DEFAULT_FOCUS_CHIME);
  // Start / pause / resume cues, chosen in the main window's settings.
  const focusCuesRef = useRef<Record<FocusCueSlot, FocusCueId>>({ ...DEFAULT_FOCUS_CUES });
  const lastTimerJsonRef = useRef<string | null>(null);
  const timerHydratedRef = useRef(false);
  // Ignore stale server pulls briefly after a local change so they can't undo it.
  const lastLocalTimerChangeRef = useRef(0);
  /** When this window last WROTE the timer — anything older is a stale echo. */
  const lastLocalPushAtRef = useRef(0);
  /** Pending coalesced write for duration-only nudges (the +/- buttons and A/D). */
  const pushTimeoutRef = useRef<number | null>(null);
  const lastTransitionKeyRef = useRef<string | null>(null);
  const lastTimerPushKeyRef = useRef<string | null>(null);
  const [editingFocusMinutes, setEditingFocusMinutes] = useState(false);
  const [focusMinutesDraft, setFocusMinutesDraft] = useState('60');
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  const [prayer, setPrayer] = useState<PrayerSettings>(DEFAULT_PRAYER_SETTINGS);
  const [categories, setCategories] = useState<EventCategory[]>(DEFAULT_CATEGORIES);
  const [focusCollapsed, setFocusCollapsed] = useState(false);
  const focusCompleteRef = useRef(false);
  const [focusCelebrate, setFocusCelebrate] = useState(false);
  const [stickyAllDayWidget, setStickyAllDayWidget] = useState(true);
  const [stickyTasksWidget, setStickyTasksWidget]   = useState(true);
  const [showTaskRow, setShowTaskRow]               = useState(true);
  const [taskColor, setTaskColor]                   = useState('#7dd3fc');
  const [taskCheckboxShape, setTaskCheckboxShape]   = useState<TaskCheckboxShape>('circle');
  const [tasks, setTasks]                           = useState<TaskData>({});
  const [overflowModal, setOverflowModal]           = useState<{
    type: 'all-day' | 'tasks';
    title: string;
    items: any[];
  } | null>(null);

  // ── Load Settings and initial events ───────────────────────────────────────
  useEffect(() => {
    // Fallback load local storage for events only
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { try { setEvents(migrateEvents(JSON.parse(saved) as PlannerData).events); } catch (_) {} }
    setFocusSessions(loadLocalFocusSessions());
    setFocusTimer(loadLocalFocusTimer());

    const applyTasks = (data: any) => {
      if (data && typeof data === 'object' && !Array.isArray(data)) setTasks(coerceTasks(data));
    };
    const loadTasks = () => {
      fetch('/api/tasks')
        .then(r => r.json())
        .then(applyTasks)
        .catch(() => {
          try {
            const str = localStorage.getItem(TASKS_STORAGE_KEY);
            if (str) applyTasks(JSON.parse(str));
          } catch (_) {}
        });
    };
    loadTasks();

    // Settings come from the shared backend so the widget always matches the main window.
    // EXCEPT the keys that belong to this screen rather than to the plan —
    // dark mode, the grid interval, the visible hour window. The side window
    // lives on the same machine as the main window, so it takes those from the
    // per-device store instead; reading them from the shared file would make it
    // wear whatever theme the phone last chose.
    const applySettings = (s: any) => {
      if (s && typeof s === 'object') {
        if (s.widgetDarkPreset) setWidgetDarkPreset(s.widgetDarkPreset as DarkPreset);
        if (s.widgetLightPreset) setWidgetLightPreset(s.widgetLightPreset as LightPreset);
        if (s.timeFormat) setTimeFormat(s.timeFormat as TimeFormat);
        if (s.weekStartsOn != null) setWeekStartsOn(s.weekStartsOn as WeekStartsOn);
        if (typeof s.stickyAllDayWidget === 'boolean') setStickyAllDayWidget(s.stickyAllDayWidget);
        if (typeof s.stickyTasksWidget === 'boolean') setStickyTasksWidget(s.stickyTasksWidget);
        if (s.taskColor) setTaskColor(s.taskColor);
        if (s.taskCheckboxShape) setTaskCheckboxShape(s.taskCheckboxShape as TaskCheckboxShape);
        if (s.focusDayStartHour != null) setFocusDayStartHour(Math.max(0, Math.min(23, Number(s.focusDayStartHour))));
        if (s.shortcuts) setShortcuts(coerceShortcuts(s.shortcuts));
        setPrayer(coercePrayerSettings(s.prayer));
        setHardware(coerceHardwareSettings(s.hardware));
        if (s.categories) setCategories(coerceCategories(s.categories));
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

    // This machine's own look and grid, shared with the main planner window.
    const applyDevice = (raw: any) => {
      if (!raw || typeof raw !== 'object') return;
      if (typeof raw.darkMode === 'boolean') setDarkMode(raw.darkMode);
      if (raw.eventColorStyle) setEventColorStyle(raw.eventColorStyle as EventCardStyle);
      if (raw.interval != null) setIntervalOpt(raw.interval as IntervalMin);
      if (raw.dayStartH != null) setDayStartH(raw.dayStartH);
      if (raw.dayEndH != null) setDayEndH(raw.dayEndH);
      if (typeof raw.showTaskRow === 'boolean') setShowTaskRow(raw.showTaskRow);
    };
    applyDevice(loadDeviceSettingsLocal());
    fetchDeviceSettings().then(applyDevice).catch(() => {});
    const unsubDevice = subscribeDeviceSettings(applyDevice);

    const unsubSettings = subscribeSettingsChange(applySettings);
    const loadSettings = () => {
      fetch('/api/settings')
        .then(r => r.json())
        .then(applySettings)
        .catch(err => console.error('Failed to sync widget settings:', err));
      fetchDeviceSettings().then(applyDevice).catch(() => {});
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

    // Only adopt a session list that differs from the one already shown. Both
    // the poll and the stream hand over a freshly parsed array each time, and a
    // new array identity re-runs every focus-analysis memo downstream even when
    // the data is byte-identical. Same guard the events/tasks handlers use.
    const applyFocusSessions = (data: unknown) => {
      const sessions = safeFocusSessions(data);
      setFocusSessionsHydrated(true);
      const json = JSON.stringify(sessions);
      if (json === lastFocusSessionsJsonRef.current) return;
      lastFocusSessionsJsonRef.current = json;
      setFocusSessions(sessions);
      localStorage.setItem(FOCUS_SESSIONS_KEY, json);
    };
    const loadFocusSessions = () => {
      fetch('/api/focus-sessions')
        .then(r => r.json())
        .then(applyFocusSessions)
        .catch(err => {
          console.error('Failed to sync focus sessions:', err);
          // The cached copy is all we are going to get; better the LCD mirrors
          // it than sits on "waiting" forever.
          setFocusSessionsHydrated(true);
        });
    };

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === FOCUS_TIMER_KEY) setFocusTimer(loadLocalFocusTimer());
      if (event.key === STORAGE_KEY && event.newValue) {
        try { setEvents(migrateEvents(JSON.parse(event.newValue) as PlannerData).events); } catch (_) {}
      }
      if (event.key === TASKS_STORAGE_KEY && event.newValue) {
        try { applyTasks(JSON.parse(event.newValue)); } catch (_) {}
      }
    };
    window.addEventListener('storage', handleStorage);

    const syncWidgetData = () => {
      loadEvents();
      loadTasks();
    };

    // Both of the widget's polls back off the moment their live stream is up,
    // exactly as the main window's do. Before this the widget re-fetched and
    // re-parsed the whole event store every 2.5s and the running timer every
    // 1.5s, forever, whether or not anything had changed and whether or not the
    // stream had already pushed the same data — roughly two HTTP round-trips a
    // second, permanently, in a window that is always open. The polls exist as
    // a safety net for a dropped stream, not as the transport, so once the
    // stream connects they only need to tick slowly; if it errors they speed
    // back up and carry the widget until it reconnects.
    const STREAM_UP_MS = 60_000;
    const STREAM_DOWN_MS = 2_500;
    let dataPollId = 0 as unknown as ReturnType<typeof setInterval>;
    const setDataPoll = (ms: number) => {
      clearInterval(dataPollId);
      dataPollId = setInterval(syncWidgetData, ms);
    };
    setDataPoll(STREAM_DOWN_MS);
    window.addEventListener('focus', syncWidgetData);

    // Shared running-timer state (see home.tsx for the echo-guard rationale).
    // `live` = arrived over the stream, so it can't be stale; only a poll needs
    // the grace window (see home.tsx for the full rationale).
    const applyTimerFromServer = (data: unknown, live = false) => {
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) { timerHydratedRef.current = true; return; }
      const incoming = coerceFocusTimer(data);
      const json = focusTimerIdentity(incoming);
      const isFirstHydration = !timerHydratedRef.current;
      timerHydratedRef.current = true;
      if (json === lastTimerJsonRef.current) return;
      // Older than our own last write ⇒ it IS our own write, broadcast back late.
      // Applying it would drag the value back to a version the user has already
      // moved past — the stutter when holding down +/- or tapping A/D quickly.
      // This applies to streamed events too; being "live" only means it arrived
      // promptly, not that it describes a newer state.
      if (incoming.updatedAt && incoming.updatedAt < lastLocalPushAtRef.current) return;
      if (!live && Date.now() - lastLocalTimerChangeRef.current < 4000) return;
      lastTimerJsonRef.current = json;
      lastTimerPushKeyRef.current = focusTimerPushKey(incoming);
      lastTransitionKeyRef.current = focusTimerTransitionKey(incoming);
      if (isFirstHydration) {
        prevRunningRef.current = incoming.isRunning;
        prevSessionRef.current = incoming.sessionStartedAt ?? null;
      }
      setFocusTimer(incoming);
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
      // Without this, tasks were the one store the stream didn't carry — so once
      // the stream came up and the poll backed off to a minute, a task added in
      // the main window took up to that long to appear here.
      on('tasks', applyTasks);
      dbStream.onopen = () => setDataPoll(STREAM_UP_MS);
      dbStream.onerror = () => setDataPoll(STREAM_DOWN_MS);
    } catch (_) { /* fall back to the polls below */ }

    // Safety net only — the stream is what makes this feel instant.
    const settingsPollId = setInterval(loadSettings, 30000);
    const focusPollId = setInterval(loadFocusSessions, 30000);
    // Live push of the shared timer; the poll below is only a safety net for a
    // dropped stream (see home.tsx).
    let timerStream: EventSource | null = null;
    try {
      timerStream = new EventSource('/api/focus-timer/stream');
      timerStream.onmessage = (evt) => {
        try { applyTimerFromServer(JSON.parse(evt.data), true); } catch (_) { /* ignore */ }
      };
      timerStream.onopen = () => setTimerPoll(STREAM_UP_MS);
      timerStream.onerror = () => setTimerPoll(1500);
    } catch (_) { /* fall back to the poll */ }
    let timerPollId = 0 as unknown as ReturnType<typeof setInterval>;
    function setTimerPoll(ms: number) {
      clearInterval(timerPollId);
      timerPollId = setInterval(pullTimer, ms);
    }
    setTimerPoll(1500);
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
      setFocusTimer(prev => checkpointFocusTimer(prev));
    }, 5000);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener('focus', syncWidgetData);
      clearInterval(dataPollId);
      clearInterval(settingsPollId);
      clearInterval(focusPollId);
      clearInterval(timerPollId);
      clearInterval(clockId);
      clearInterval(checkpointId);
      if (timerStream) timerStream.close();
      if (dbStream) dbStream.close();
      unsubSettings();
      unsubDevice();
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
  const todayColIdx = days.findIndex(d => isSameDay(d, today));

  // Resolve raw storage into the items visible in the current (real) week, so the
  // widget honours single-week items, recurring versions and per-week overrides.
  const viewedWeekKey = weekKeyOf(today, weekStartsOn);
  const rawWeekEvents = useMemo(() => resolveWeek(events, viewedWeekKey, undefined, weekStartsOn), [events, viewedWeekKey, weekStartsOn]);
  const weekEvents = useMemo(() => {
    const hiddenCatIds = new Set(categories.filter(c => c.showInWidget === false).map(c => c.id));
    if (hiddenCatIds.size === 0) return rawWeekEvents;
    const filtered: Record<string, PlannerEvent> = {};
    for (const [k, ev] of Object.entries(rawWeekEvents)) {
      if (ev.categoryId && hiddenCatIds.has(ev.categoryId)) continue;
      filtered[k] = ev;
    }
    return filtered;
  }, [rawWeekEvents, categories]);

  const slots = generateSlots(interval, dayStartH, dayEndH);
  const sh = SLOT_H[interval];
  const totalH = slots.length * sh;
  // Identical resolution to the main window, so a card looks the same in both.
  const widgetTheme = themePalette(darkMode, widgetDarkPreset, widgetLightPreset);
  const chipColors = (ev: PlannerEvent) =>
    gcalChipColors(resolveEventColor(ev, categories), { dark: darkMode, style: eventColorStyle, pageBg: widgetTheme.rootBg })
      ?? { bg: '#dcfce7', border: '#86efac', text: '#14532d', textMuted: '#2f6b45' };

  const normNowMin = normalizeMin(nowMin, dayStartH);
  const nowInView = normNowMin >= dayStartMin && normNowMin <= dayEndMin;

  // ── Prayer times ───────────────────────────────────────────────────────────
  // Same cache the main window uses (the server owns it), so showing them here
  // costs no extra API calls.
  const widgetPrayer = useMemo(
    () => (prayer.showInWidget ? prayer : { ...prayer, enabled: false }),
    [prayer],
  );
  // Keyed off the date STRING: `today` is rebuilt every tick, and a fresh
  // Date object every second would re-run the loader forever.
  const prayerDayStr = prayerDateKey(today);
  const prayerDates = useMemo(() => {
    const d = new Date(`${prayerDayStr}T00:00:00`);
    return [d, addDays(d, 1)];
  }, [prayerDayStr]);
  const { prayersFor, isDone: isPrayerDone, toggleDone: togglePrayerDone } = usePrayerTimes(widgetPrayer, prayerDates);
  /** The day's prayers, for the list. */
  const dayPrayers = useMemo(
    () => (widgetPrayer.enabled ? prayersFor(prayerDates[0]) : []),
    [widgetPrayer.enabled, prayersFor, prayerDates],
  );
  /** The ones that land inside the visible hour window, with their grid minute. */
  const timelinePrayers = useMemo(() => {
    if (!widgetPrayer.enabled) return [] as Array<PrayerOccurrence & { norm: number }>;
    const out: Array<PrayerOccurrence & { norm: number }> = [];
    for (const p of prayersFor(prayerDates[0])) {
      if (p.minutes >= dayStartMin) out.push({ ...p, norm: p.minutes });
    }
    // The column runs dayStart → next dayStart, so tomorrow's pre-dawn prayers
    // belong to the bottom of this one.
    for (const p of prayersFor(prayerDates[1])) {
      if (p.minutes < dayStartMin) out.push({ ...p, norm: p.minutes + 1440 });
    }
    return out
      .filter(p => p.norm >= dayStartMin && p.norm <= dayEndMin)
      .sort((a, b) => a.norm - b.norm);
  }, [widgetPrayer.enabled, prayersFor, prayerDates, dayStartMin, dayEndMin]);
  const focusElapsedSeconds = getFocusTimerElapsedSeconds(focusTimer, nowTick);
  const focusRemainingSeconds = Math.max(0, focusTimer.plannedSeconds - focusElapsedSeconds);
  // "Today" for focus stats respects the configurable day-start hour (e.g. before
  // 3 AM still counts as the previous day).
  const focusTodayKey = focusDayKey(today, focusDayStartHour);
  const focusTodayMidnight = new Date(`${focusTodayKey}T00:00:00`);
  // The live session counts toward the day only for the part a manual edit in the
  // main window hasn't already written into the logged sessions — same rule as
  // there, so the two windows never disagree about today's total.
  const todayFocusSeconds = sumFocusSecondsForDay(focusSessions, focusTodayMidnight, focusDayStartHour)
    + (focusTimer.sessionStartedAt && focusDayKey(focusTimer.sessionStartedAt, focusDayStartHour) === focusTodayKey
      ? getFocusTimerUncreditedSeconds(focusTimer, nowTick)
      : 0);
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
      const isNoDur = Boolean(ev.noDuration || ev.endTime === ev.startTime);
      const s = normalizeMin(timeToMin(ev.startTime), dayStartH);
      let e = isNoDur ? s + 10 : normalizeMin(timeToMin(ev.endTime), dayStartH);
      if (!isNoDur && e <= s) e += 1440;
      const isSpanning = !isNoDur && s < dayStartMin + 1440 && e > dayStartMin + 1440;

      if (isSpanning) {
        if (ev.dayIndex === todayColIdx) {
          items.push({ ev, key: ev.id, startMin: s, endMin: dayStartMin + 1440, segKind: 'tail' });
        }
        if (ev.dayIndex + 1 === todayColIdx) {
          items.push({ ev, key: `${ev.id}__head`, startMin: dayStartMin, endMin: e - 1440, segKind: 'head' });
        }
        continue;
      }
      if (ev.dayIndex === todayColIdx) {
        items.push({
          ev, key: ev.id, segKind: 'normal',
          startMin: s,
          endMin: e,
        });
      }
    }
    return items;
  }, [weekEvents, todayColIdx, dayStartMin, dayStartH]);

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
  const timelineGridRef = useRef<HTMLDivElement>(null);
  const [showLiveBtn, setShowLiveBtn] = useState(false);
  const isProgrammaticScroll = useRef(false);
  const isTrackingLive = useRef(true);

  // Helper to calculate top sticky header obstruction height inside scrollContainer
  const getStickyHeaderHeight = (container: HTMLElement): number => {
    const containerTop = container.getBoundingClientRect().top;
    let maxBottom = containerTop;
    const stickyEls = container.querySelectorAll('.sticky');
    stickyEls.forEach(el => {
      const rect = el.getBoundingClientRect();
      if (rect.top <= containerTop + 10 && rect.bottom > containerTop) {
        if (rect.bottom > maxBottom) {
          maxBottom = rect.bottom;
        }
      }
    });
    return Math.max(0, maxBottom - containerTop);
  };

  const checkLiveVisibility = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const stickyHeaderH = getStickyHeaderHeight(container);
    const gridOffset = timelineGridRef.current?.offsetTop ?? 0;
    const lineTop = gridOffset + minToY(normNowMin, interval, dayStartH);
    const isVisible = lineTop >= container.scrollTop + stickyHeaderH && lineTop <= container.scrollTop + container.clientHeight;
    setShowLiveBtn(!isVisible);
  }, [normNowMin, interval, dayStartH]);

  const scrollAnimFrame = useRef(0);
  const centerScrollOnLive = useCallback((smooth = true) => {
    const container = scrollContainerRef.current;
    if (!container || container.clientHeight === 0) return;
    const stickyHeaderH = getStickyHeaderHeight(container);
    const visibleHeight = Math.max(100, container.clientHeight - stickyHeaderH);
    const visibleCenterOffset = stickyHeaderH + visibleHeight / 2;

    const gridOffset = timelineGridRef.current?.offsetTop ?? 0;
    const lineTop = gridOffset + minToY(normNowMin, interval, dayStartH);
    const targetTop = Math.max(0, lineTop - visibleCenterOffset);

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
  }, [normNowMin, interval, dayStartH]);

  const handleScroll = useCallback(() => {
    if (isProgrammaticScroll.current) {
      isProgrammaticScroll.current = false;
      return;
    }
    checkLiveVisibility();
    // If the user scrolls away, pause live tracking
    if (isTrackingLive.current) {
      isTrackingLive.current = false;
    }
  }, [checkLiveVisibility]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    container.addEventListener('scroll', handleScroll);
    checkLiveVisibility();
    return () => container.removeEventListener('scroll', handleScroll);
  }, [handleScroll, checkLiveVisibility]);

  // Keep centering dynamically if the user resizes the widget window
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    let frameId = 0;
    const observer = new ResizeObserver(() => {
      if (isTrackingLive.current) {
        cancelAnimationFrame(frameId);
        frameId = requestAnimationFrame(() => {
          centerScrollOnLive(false);
        });
      }
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frameId);
    };
  }, [centerScrollOnLive]);

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
  }, [slots, dayStartH, interval, centerScrollOnLive]);

  const scrollToLive = useCallback(() => {
    isTrackingLive.current = true;
    setShowLiveBtn(false);
    centerScrollOnLive(true);
  }, [centerScrollOnLive]);

  // On first launch, act as though Go Live was pressed.
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
  }, [slots.length, events, scrollToLive]);

  // Keep centering dynamically every time the live time updates
  const lastCenteringMin = useRef(-1);
  useEffect(() => {
    const currentMin = Math.floor(normNowMin);
    if (currentMin === lastCenteringMin.current) return;
    lastCenteringMin.current = currentMin;

    if (isTrackingLive.current) {
      centerScrollOnLive(true);
    }
  }, [nowTick, normNowMin, centerScrollOnLive]);

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
    const json = JSON.stringify(sessions);
    // Our own write; recognise it when the server streams it back.
    lastFocusSessionsJsonRef.current = json;
    localStorage.setItem(FOCUS_SESSIONS_KEY, json);
    fetch('/api/focus-sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
    }).catch(err => console.error('Failed to save focus sessions:', err));
  }, []);

  const completeFocusSession = useCallback((durationSeconds?: number, auto = false, opts?: { endedAt?: Date; id?: string }) => {
    // Seconds already banked by a manual day edit are logged; don't log them twice.
    const credited = Math.max(0, focusTimer.creditedSeconds ?? 0);
    const duration = loggableSessionSeconds(focusTimer, durationSeconds ?? getFocusTimerElapsedSeconds(focusTimer));
    if (duration <= 0) {
      setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
      return;
    }

    // `opts.endedAt` is for a session recovered after the machine was switched
    // off: it ended when the PC did, not when we noticed on the next launch.
    const endedAt = opts?.endedAt ?? new Date();
    const startedAt = focusTimer.sessionStartedAt && credited === 0
      ? new Date(focusTimer.sessionStartedAt)
      : new Date(endedAt.getTime() - duration * 1000);

    const session: FocusSession = {
      // Deterministic id for auto-completions so this window and the main window
      // (both counting down the same shared timer) log ONE session, not two.
      id: opts?.id ?? (auto ? autoSessionId(focusTimer.sessionStartedAt, focusTimer.plannedSeconds) : uid()),
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

  // Shutdown / sleep recovery — see the matching block in home.tsx. Both windows
  // refresh the same shared heartbeat, so "stale" means no window was alive.
  const focusTimerRef = useRef(focusTimer);
  focusTimerRef.current = focusTimer;
  // Set when the timer ends on its own (hit zero, or a shutdown-recovered
  // session). Completing resets the timer, so the remaining seconds are no use
  // for telling a completion apart from a pause - see home.tsx.
  const focusAutoEndedRef = useRef(false);
  const completeFocusSessionRef = useRef(completeFocusSession);
  completeFocusSessionRef.current = completeFocusSession;
  const [focusLiveSession, setFocusLiveSession] = useState<string | null>(null);

  const runFocusHeartbeat = useCallback(() => {
    const timer = focusTimerRef.current;
    if (!timer.isRunning || !timer.sessionStartedAt) return;
    const session = timer.sessionStartedAt;
    fetch('/api/focus-heartbeat')
      .then(r => r.json())
      .then(data => {
        const current = focusTimerRef.current;
        if (!current.isRunning || current.sessionStartedAt !== session) return; // moved on
        const recovery = focusRecoveryFor(current, safeFocusHeartbeat(data));
        if (!recovery) {
          setFocusLiveSession(session);
          fetch('/api/focus-heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              at: new Date().toISOString(),
              sessionStartedAt: session,
              elapsedSeconds: getFocusTimerElapsedSeconds(current),
            }),
          }).catch(() => {});
          return;
        }
        focusAutoEndedRef.current = true; // recovery, not a pause the user asked for
        if (recovery.durationSeconds >= MIN_RECOVERED_SESSION_SECONDS) {
          completeFocusSessionRef.current(recovery.durationSeconds, false, {
            endedAt: new Date(recovery.endedAt),
            id: recoveredSessionId(session),
          });
        } else {
          setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
        }
      })
      .catch(() => setFocusLiveSession(session));
  }, []);

  useEffect(() => {
    runFocusHeartbeat();
  }, [runFocusHeartbeat, focusTimer.isRunning, focusTimer.sessionStartedAt]);

  useEffect(() => {
    const id = setInterval(runFocusHeartbeat, FOCUS_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runFocusHeartbeat]);

  useEffect(() => {
    localStorage.setItem(FOCUS_TIMER_KEY, JSON.stringify(focusTimer));
    // Don't push to the backend until we've hydrated from it (avoid clobbering a live
    // session owned by another window before our first pull).
    if (!timerHydratedRef.current) return;
    const json = focusTimerIdentity(focusTimer);
    if (json === lastTimerJsonRef.current) return;
    // Running-session checkpoints carry no new information; pushing them would
    // stomp a start/pause made elsewhere (main window, system-wide hotkey).
    const pushKey = focusTimerPushKey(coerceFocusTimer(focusTimer));
    if (pushKey === lastTimerPushKeyRef.current) return;
    lastTimerPushKeyRef.current = pushKey;
    lastTimerJsonRef.current = json;
    lastLocalTimerChangeRef.current = Date.now();

    // Holding A/D (or clicking +/- repeatedly) used to fire one POST per press,
    // each writing the file, taking a backup and broadcasting to both windows.
    // Duration nudges are coalesced into a single write; a start/pause still
    // goes out immediately, because the other window's cue depends on it.
    const transitionKey = focusTimerTransitionKey(focusTimer);
    const durationOnly = lastTransitionKeyRef.current === transitionKey;
    lastTransitionKeyRef.current = transitionKey;

    const send = () => {
      const stamp = Date.now();
      lastLocalPushAtRef.current = stamp;
      lastLocalTimerChangeRef.current = stamp;
      fetch('/api/focus-timer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...JSON.parse(json), updatedAt: stamp }),
      }).catch(() => {});
    };

    if (pushTimeoutRef.current !== null) {
      window.clearTimeout(pushTimeoutRef.current);
      pushTimeoutRef.current = null;
    }
    if (durationOnly) {
      pushTimeoutRef.current = window.setTimeout(() => { pushTimeoutRef.current = null; send(); }, 220);
    } else {
      send();
    }
  }, [focusTimer]);

  useEffect(() => {
    if (!editingFocusMinutes) {
      setFocusMinutesDraft(String(Math.max(1, Math.round(focusTimer.plannedSeconds / 60))));
    }
  }, [editingFocusMinutes, focusTimer.plannedSeconds]);

  useEffect(() => {
    // Stand down until the heartbeat has confirmed this session is really live —
    // otherwise a session the PC was switched off during gets logged at full
    // length, stamped with the moment the app was reopened.
    const liveSession = focusLiveSession === focusTimer.sessionStartedAt;
    if (focusTimer.isRunning && liveSession && focusRemainingSeconds <= 0 && !focusCompleteRef.current) {
      focusCompleteRef.current = true;
      if (claimFocusCompletion()) {
        setFocusCelebrate(true);
        window.setTimeout(() => setFocusCelebrate(false), 2600);
      }
      // Claimed through the server, not localStorage — see home.tsx.
      claimFocusCue(
        `complete|${focusTimer.sessionStartedAt ?? ''}|${focusTimer.plannedSeconds}`,
        () => playFocusChime(focusChimeRef.current),
        { playIfUnreachable: Date.now() - lastLocalPushAtRef.current < 3000 },
      );
      focusAutoEndedRef.current = true;
      completeFocusSession(focusTimer.plannedSeconds, true);
    } else if (!focusTimer.isRunning || focusRemainingSeconds > 0) {
      focusCompleteRef.current = false;
    }
  }, [completeFocusSession, focusRemainingSeconds, focusTimer.isRunning, focusTimer.plannedSeconds, focusTimer.sessionStartedAt, focusLiveSession]);

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
    if (prevRunning === null || !timerHydratedRef.current) return; // first render or unhydrated — nothing to compare against

    let slot: FocusCueSlot | null = null;
    if (running && !prevRunning) {
      slot = session && session === prevSession ? 'resume' : 'start';
    } else if (!running && prevRunning) {
      // Hitting zero is a completion, not a pause: the session-complete chime
      // covers that one, so this must not also fire the pause cue. The panel
      // still opens back up, as it does on a pause.
      if (focusAutoEndedRef.current) { focusAutoEndedRef.current = false; setFocusCollapsed(false); }
      else slot = 'pause';
    }
    if (!slot) return;

    // Fold the panel away while running and open it back up when paused, no
    // matter where the toggle came from — this window's button, the main window,
    // or the system-wide hotkey.
    setFocusCollapsed(slot !== 'pause');

    // Reject stale cues (e.g. widget opening while a session is already in progress)
    if (!isFocusCueFresh(focusTimer, slot)) return;

    const cue = focusCuesRef.current[slot];
    if (cue === 'none') return;
    // If the claim can't be reached (dev-server restart), only the window that
    // actually performed the toggle sounds it — otherwise both do, and you hear
    // the cue twice.
    claimFocusCue(focusCueKey(slot, focusTimer), () => playFocusCue(cue), {
      playIfUnreachable: Date.now() - lastLocalPushAtRef.current < 3000,
    });
  }, [focusTimer]);

  const startFocus = () => {
    const startedAt = new Date().toISOString();
    setFocusCollapsed(true);
    setFocusTimer(prev => {
      // Already running (double-click, or the hotkey and this button racing):
      // re-anchoring would silently drop everything since the last checkpoint.
      if (prev.isRunning && prev.lastStartedAt) return prev;
      return {
        ...prev,
        isRunning: true,
        lastStartedAt: startedAt,
        sessionStartedAt: prev.sessionStartedAt ?? startedAt,
        lastPausedAt: null,
      };
    });
  };

  const pauseFocus = () => {
    setFocusTimer(prev => (prev.isRunning ? pauseFocusTimer(prev) : prev));
  };

  const resetFocus = () => {
    setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
  };

  const stopFocus = () => {
    completeFocusSession(focusElapsedSeconds);
  };

  // ── ESP32 desk controller ──────────────────────────────────────────────────
  // Both windows run this, but the server hands the lease to exactly one, so a
  // single button press is never acted on twice. The window without the lease
  // still tracks the countdown so it can display it — and takes over within
  // seconds if the main window is closed.
  const hardwareController = useHardwareController({
    settings: hardware,
    session: {
      isRunning: focusTimer.isRunning,
      hasSession: Boolean(focusTimer.sessionStartedAt),
    },
    display: {
      mode: focusTimer.isRunning ? 'running' : focusTimer.sessionStartedAt ? 'paused' : 'idle',
      remainingSeconds: focusRemainingSeconds,
      todaySeconds: todayFocusSeconds,
      sessionsToday: todayFocusSessions,
      // Until both have arrived from the server this window's totals are a
      // guess, and a guess on the LCD reads exactly like a fact.
      ready: timerHydratedRef.current && focusSessionsHydrated,
    },
    onToggle: () => { if (focusTimer.isRunning) pauseFocus(); else startFocus(); },
    onStart: startFocus,
    onResume: startFocus,
    onPause: pauseFocus,
    onTerminate: stopFocus,
  });
  const hardwareArmSeconds = hardwareController.armSeconds;

  // Nothing on screen owns the desk countdown, so a deliberate start/pause or
  // stop during it means "call it off" rather than "start it now".
  const { reportManualStop } = hardwareController;
  const toggleFocus = () => {
    if (hardwareArmSeconds > 0) { reportManualStop(); return; }
    if (focusTimer.isRunning) pauseFocus(); else startFocus();
  };
  const stopFocusByHand = () => {
    reportManualStop();
    if (hardwareArmSeconds > 0) return;
    stopFocus();
  };

  const setFocusMinutes = (minutes: number) => {
    const safeMinutes = Math.max(1, Math.floor(minutes));
    setFocusTimer(prev => ({
      ...prev,
      plannedSeconds: safeMinutes * 60,
    }));
  };

  // Reads the current planned time from `prev` rather than the render closure so
  // the key handler below can be bound once and never go stale.
  const adjustFocusMinutes = useCallback((deltaMinutes: number) => {
    setFocusTimer(prev => {
      const currentMinutes = Math.max(1, Math.round(prev.plannedSeconds / 60));
      const nextMinutes = deltaMinutes > 0
        ? Math.max(5, Math.ceil((currentMinutes + 1) / 5) * 5)
        : Math.max(5, Math.floor((currentMinutes - 1) / 5) * 5);
      return { ...prev, plannedSeconds: nextMinutes * 60 };
    });
  }, []);

  // Configurable widget shortcuts (widgetMinus, widgetPlus, widgetStart, goToLive).
  // Skipped while a text field has focus so typing is not hijacked.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;

      if (matchesCombo(shortcuts.widgetMinus, e)) {
        e.preventDefault();
        adjustFocusMinutes(-5);
      } else if (matchesCombo(shortcuts.widgetPlus, e)) {
        e.preventDefault();
        adjustFocusMinutes(5);
      } else if (matchesCombo(shortcuts.goToLive, e)) {
        e.preventDefault();
        scrollToLive();
      } else if (matchesCombo(shortcuts.widgetStart, e)) {
        e.preventDefault();
        toggleFocus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [adjustFocusMinutes, shortcuts, scrollToLive, toggleFocus]);

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
    const ev = events[masterId];
    if (!ev) return;
    const completedDates = ev.completedDates || [];
    const updatedDates = completedDates.includes(dateStr)
      ? completedDates.filter(d => d !== dateStr)
      : [...completedDates, dateStr];
    const updatedEvents = {
      ...events,
      [masterId]: { ...ev, completedDates: updatedDates, updatedAt: Date.now() },
    };
    setEvents(updatedEvents);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updatedEvents));
    const url = Object.keys(updatedEvents).length === 0 ? '/api/events?force=1' : '/api/events';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedEvents),
    }).catch(err => console.error("Failed to save checkbox state from widget:", err));
  };

  const handleWindowMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;

    // Do not initiate window drag if user clicked an interactive element
    const target = e.target as HTMLElement | null;
    if (target) {
      const interactive = target.closest(
        'button, input, textarea, select, a, [role="button"], [data-no-drag="true"], .no-drag'
      );
      if (interactive || target.isContentEditable) {
        return;
      }
    }

    if ((window as any).pywebview?.api?.start_drag) {
      (window as any).pywebview.api.start_drag();
    }

    let isDragging = true;
    let startX = e.screenX;
    let startY = e.screenY;

    // Each move_window_relative is a round-trip into pywebview. Firing one per
    // mouse event (hundreds a second) queued far more window moves than the
    // compositor could show, so the window trailed the cursor. Accumulate the
    // deltas and send a single move per frame instead — same total distance,
    // one call per painted frame.
    let pendingDx = 0, pendingDy = 0, moveFrame = 0;
    const flushWindowMove = () => {
      moveFrame = 0;
      const dx = pendingDx, dy = pendingDy;
      pendingDx = 0; pendingDy = 0;
      if (!isDragging || (dx === 0 && dy === 0)) return;
      (window as any).pywebview?.api?.move_window_relative?.(dx, dy);
    };
    const handleMouseMove = (ev: MouseEvent) => {
      if (!isDragging) return;
      const dx = ev.screenX - startX;
      const dy = ev.screenY - startY;
      if (dx !== 0 || dy !== 0) {
        startX = ev.screenX;
        startY = ev.screenY;
        pendingDx += dx;
        pendingDy += dy;
        if (!moveFrame) moveFrame = requestAnimationFrame(flushWindowMove);
      }
    };

    const handleMouseUp = () => {
      if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; flushWindowMove(); }
      isDragging = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };


  // ── Style overrides ────────────────────────────────────────────────────────
  const surfaceBg  = darkMode ? widgetTheme.surfaceBg : 'rgba(255,255,255,0.60)';
  const surfaceBdr = widgetTheme.surfaceBdr;
  const menuText   = darkMode ? '#e8e8e8' : '#1a1a1a';
  const menuSub    = darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';

  return (
    <div
      onMouseDown={handleWindowMouseDown}
      className={`h-screen bg-background text-foreground flex flex-col font-sans select-none overflow-hidden ${darkMode ? 'dark' : ''}`}
      style={{ background: widgetTheme.rootBg }}
    >
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
        onMouseDown={handleWindowMouseDown}
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
              {timeFormat === '24h' ? format(today, 'HH:mm:ss') : format(today, 'h:mm:ss a')}
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

      <section className={`flex-shrink-0 px-3 ${focusCollapsed ? 'py-2' : 'py-3'} border-b border-border/50 transition-smooth duration-200`} style={{ background: darkMode ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.38)' }}>
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
                className={`${focusCollapsed ? 'text-[18px]' : 'text-[28px]'} leading-none font-semibold tabular-nums tracking-normal transition-smooth duration-200`}
                style={{ color: focusCelebrate ? '#4ade80' : menuText }}
                animate={focusCelebrate
                  ? { scale: [1, 1.16, 1, 1.08, 1], textShadow: ['0 0 0px rgba(74,222,128,0)', '0 0 18px rgba(74,222,128,0.75)', '0 0 0px rgba(74,222,128,0)'] }
                  : { scale: 1 }}
                transition={focusCelebrate ? { duration: 1.5, ease: 'easeInOut' } : { duration: 0.3 }}
              >
                {hardwareArmSeconds > 0
                  ? <span className="text-[13px] font-semibold whitespace-nowrap" style={{ color: '#60a5fa' }}>Starting in {hardwareArmSeconds}s</span>
                  : formatCountdown(focusRemainingSeconds)}
              </motion.div>
              <button
                onClick={() => setFocusCollapsed(v => !v)}
                className="w-7 h-7 rounded-md flex items-center justify-center transition-smooth active:scale-[0.96]"
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
              className="h-full rounded-full transition-smooth duration-300"
              style={{
                width: `${focusProgressPct}%`,
                background: focusTimer.isRunning ? '#60a5fa' : darkMode ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.28)',
              }}
            />
          </div>

          <div className="px-3 py-2 flex items-center gap-2">
            <button
              onClick={() => adjustFocusMinutes(-5)}
              className="w-8 h-8 rounded-md flex items-center justify-center transition-smooth active:scale-[0.96]"
              title="Decrease focus duration by 5 minutes (A)"
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
              className="w-8 h-8 rounded-md flex items-center justify-center transition-smooth active:scale-[0.96]"
              title="Increase focus duration by 5 minutes (D)"
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
              onClick={toggleFocus}
              className="col-span-2 h-8 rounded-md flex items-center justify-center gap-1.5 text-xs font-semibold transition-smooth active:scale-[0.98]"
              style={{
                background: focusTimer.isRunning ? 'rgba(245,158,11,0.18)' : '#2563eb',
                border: `1px solid ${focusTimer.isRunning ? 'rgba(245,158,11,0.35)' : '#2563eb'}`,
                color: focusTimer.isRunning ? '#fbbf24' : '#ffffff',
              }}
            >
              {/* While the desk countdown runs this is the way out of a session
                  you did not ask for, so it says so rather than "Start". */}
              {hardwareArmSeconds > 0 ? <X size={13} /> : focusTimer.isRunning ? <Pause size={13} /> : <Play size={13} />}
              {hardwareArmSeconds > 0 ? 'Cancel' : focusTimer.isRunning ? 'Pause' : focusElapsedSeconds > 0 ? 'Resume' : 'Start'}
            </button>
            <button
              onClick={resetFocus}
              disabled={focusElapsedSeconds <= 0}
              className="h-8 rounded-md flex items-center justify-center transition-smooth active:scale-[0.98]"
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
              onClick={stopFocusByHand}
              disabled={focusElapsedSeconds <= 0}
              className="h-8 rounded-md flex items-center justify-center transition-smooth active:scale-[0.98]"
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
        {/* All-Day Events & Tasks in Widget (Configurable Sticky & Compacted) */}
        {(() => {
          const todayYmd = format(today, 'yyyy-MM-dd');
          const todayAllDay = Object.values(weekEvents).filter(ev => {
            if (!ev.allDay || ev.deleted) return false;
            const startDateStr = ev.occDate || (ev.weekKey && ev.dayIndex != null ? format(addDays(parseDate(ev.weekKey), ev.dayIndex), 'yyyy-MM-dd') : null);
            if (!startDateStr) return false;
            const startD = parseDate(startDateStr);
            const endD = addDays(startD, (ev.daysSpan || 1) - 1);
            const endStr = format(endD, 'yyyy-MM-dd');
            return todayYmd >= startDateStr && todayYmd <= endStr;
          });

          const MAX_ALL_DAY_VISIBLE = 2;
          const visibleAllDay = todayAllDay.slice(0, MAX_ALL_DAY_VISIBLE);
          const hasMoreAllDay = todayAllDay.length > MAX_ALL_DAY_VISIBLE;
          
          // Calculate height of sticky All-Day row so sticky Tasks row positions accurately right below it
          const allDayRowH = todayAllDay.length === 0 ? 0 : (visibleAllDay.length * 28 + (hasMoreAllDay ? 24 : 0) + 12);

          const res = resolveWeekTasks(tasks, viewedWeekKey, undefined, weekStartsOn);
          const targetDayIdx = Math.max(0, Math.min(6, differenceInDays(startOfDay(today), startOfDay(weekStart))));
          const todayTasks = Object.values(res).filter(t => {
            if (t.deleted || t.startTime) return false;
            return t.dayIndex === targetDayIdx;
          });

          const MAX_TASKS_VISIBLE = 3;
          const visibleTasks = todayTasks.slice(0, MAX_TASKS_VISIBLE);
          const hasMoreTasks = todayTasks.length > MAX_TASKS_VISIBLE;

          return (
            <>
              {/* All-Day row */}
              {todayAllDay.length > 0 && (
                <div
                  className={`flex border-b border-border/50 flex-shrink-0 ${stickyAllDayWidget ? 'sticky top-0 z-30 shadow-xs backdrop-blur-md' : ''}`}
                  style={{ background: darkMode ? (widgetTheme.cardBg || 'rgba(15,16,18,0.95)') : 'rgba(255,255,255,0.95)' }}
                >
                  {/* Axis spacer */}
                  <div className="flex-shrink-0 border-r border-border/50 flex items-center justify-center p-1" style={{ width: 62 }}>
                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50 text-center">All Day</span>
                  </div>
                  {/* Events list */}
                  <div className="flex-1 p-2 flex flex-col gap-1">
                    {visibleAllDay.map(ev => {
                      const { bg, border, text, accentBar } = chipColors(ev);
                      const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(todayYmd) ?? false);
                      return (
                        <div
                          key={ev.id}
                          className="px-2 py-1 rounded-md border text-[11px] font-semibold flex items-center gap-1.5 shadow-xs"
                          style={{ backgroundColor: bg, borderColor: border, borderLeft: accentBar ? `3px solid ${accentBar}` : undefined, color: text }}
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
                    {hasMoreAllDay && (
                      <button
                        type="button"
                        onClick={() => setOverflowModal({
                          type: 'all-day',
                          title: 'All-Day Events',
                          items: todayAllDay
                        })}
                        className="px-2 py-0.5 rounded-md border text-[10px] font-semibold flex items-center justify-center gap-1 transition-smooth active:scale-[0.98] shadow-2xs"
                        style={{
                          background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                          borderColor: surfaceBdr,
                          color: menuSub,
                        }}
                        title="Click to view all all-day events"
                      >
                        <MoreHorizontal size={12} />
                        <span>+{todayAllDay.length - MAX_ALL_DAY_VISIBLE} more</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

              {/* Tasks row */}
              {showTaskRow && todayTasks.length > 0 && (
                <div
                  className={`flex border-b border-border/50 flex-shrink-0 ${stickyTasksWidget ? 'sticky z-25 shadow-xs backdrop-blur-md' : ''}`}
                  style={{
                    top: stickyTasksWidget ? (stickyAllDayWidget ? allDayRowH : 0) : undefined,
                    background: darkMode ? (widgetTheme.cardBg || 'rgba(15,16,18,0.95)') : 'rgba(255,255,255,0.95)'
                  }}
                >
                  {/* Axis spacer */}
                  <div className="flex-shrink-0 border-r border-border/50 flex items-center justify-center gap-1 p-1" style={{ width: 62 }}>
                    <ListTodo size={9} style={{ color: taskColor, opacity: 0.8 }} />
                    <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50 text-center">Tasks</span>
                  </div>
                  {/* Tasks list */}
                  <div className="flex-1 p-1.5 flex flex-col gap-1">
                    {visibleTasks.map(t => {
                      const occ = t.occDate ?? null;
                      const done = isTaskDone(t, occ);
                      return (
                        <div
                          key={t.id}
                          onClick={() => {
                            const occId = t.occDate ? `${t.masterId || t.id}::${t.occDate}` : t.id;
                            const next = toggleTaskDoneHelper(tasks, occId);
                            setTasks(next);
                            localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(next));
                            const url = Object.keys(next).length === 0 ? '/api/tasks?force=1' : '/api/tasks';
                            fetch(url, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify(next),
                            }).catch(() => {});
                          }}
                          className="px-2 py-0.5 rounded-md border text-[10.5px] font-medium flex items-center gap-1.5 shadow-2xs cursor-pointer transition-opacity"
                          style={{
                            background: `${taskColor}18`,
                            borderColor: `${taskColor}44`,
                            color: menuText,
                            opacity: done ? 0.5 : 1,
                          }}
                        >
                          <span className="flex-shrink-0 flex items-center" style={{ color: taskColor }}>
                            {done ? (
                              taskCheckboxShape === 'square' ? <CheckSquare size={10} /> : <CheckCircle2 size={10} />
                            ) : (
                              taskCheckboxShape === 'square' ? <Square size={10} /> : <Circle size={10} />
                            )}
                          </span>
                          <span className={`truncate flex-1 ${done ? 'line-through opacity-60' : ''}`}>
                            {t.title || 'Untitled task'}
                          </span>
                        </div>
                      );
                    })}
                    {hasMoreTasks && (
                      <button
                        type="button"
                        onClick={() => setOverflowModal({
                          type: 'tasks',
                          title: "Today's Tasks",
                          items: todayTasks
                        })}
                        className="px-2 py-0.5 rounded-md border text-[10px] font-semibold flex items-center justify-center gap-1 transition-smooth active:scale-[0.98] shadow-2xs"
                        style={{
                          background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                          borderColor: surfaceBdr,
                          color: menuSub,
                        }}
                        title="Click to view all tasks"
                      >
                        <MoreHorizontal size={12} />
                        <span>+{todayTasks.length - MAX_TASKS_VISIBLE} more</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          );
        })()}

        {/* Prayer band. Always rendered when prayers are on: the timeline only
            covers the configured hour window, and Fajr/Isha usually fall outside
            it — this row is the one place the whole day is guaranteed visible. */}
        {dayPrayers.length > 0 && (
          <div className="flex border-b border-border/50 flex-shrink-0" style={{ background: darkMode ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)' }}>
            <div className="flex-shrink-0 border-r border-border/50 flex items-center justify-center gap-1 p-1" style={{ width: 62 }}>
              <Moon size={9} style={{ color: widgetPrayer.color, opacity: 0.85 }} />
              <span className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground/50">Prayer</span>
            </div>
            <div className="flex-1 p-1.5 flex flex-wrap gap-1">
              {dayPrayers.map(p => {
                const done = isPrayerDone(p.dateStr, p.key);
                return (
                  <button
                    key={p.id}
                    onClick={() => togglePrayerDone(p.dateStr, p.key)}
                    className="px-1.5 py-0.5 rounded-md border text-[10px] font-semibold flex items-center gap-1"
                    style={{
                      background: `${widgetPrayer.color}22`,
                      borderColor: `${widgetPrayer.color}66`,
                      color: widgetPrayer.color,
                      opacity: done ? 0.5 : 1,
                    }}
                    title={`${p.label} · ${formatTimeLabel(p.minutes, timeFormat)}${done ? ' · done' : ''}`}
                  >
                    <span className="flex items-center">
                      {done ? <CheckCircle2 size={9} /> : <Circle size={9} />}
                    </span>
                    <span style={{ textDecoration: done ? 'line-through' : 'none' }}>{p.label}</span>
                    <span className="tabular-nums opacity-80">{formatTimeLabel(p.minutes, timeFormat)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Timeline Grid (Axis + Grid Area) */}
        <div ref={timelineGridRef} className="flex flex-row relative flex-shrink-0" style={{ height: totalH }}>
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
                <div
                  className="absolute -left-[2px] now-dot-pulse"
                  style={{ width: 9, height: 9, borderRadius: '50%', background: nowAccent, top: -3.5, boxShadow: `0 0 0 3px ${nowAccentSoft}` }}
                />
                {/* Hairline that fades out toward the right edge */}
                <div
                  className="absolute left-0 right-0"
                  style={{ height: 1.5, background: `linear-gradient(to right, ${nowAccent}, ${nowAccent} 65%, ${nowAccentSoft})`, opacity: 0.9 }}
                />
                {/* Live time chip */}
                <div
                  className="absolute text-[9.5px] font-semibold tabular-nums px-1.5 py-[0.5px] rounded-full whitespace-nowrap tracking-tight"
                  style={{ right: 3, top: -8.5, background: nowAccent, color: '#fff', boxShadow: '0 1px 4px rgba(0,0,0,0.25)', letterSpacing: '0.03em' }}
                >
                  {formatTimeLabel(nowMin, timeFormat)}
                </div>
              </div>
            );
          })()}

          {/* Prayer times — zero-height overlays at the exact minute, so they
              never take space from an event or block a click on the grid. */}
          {widgetPrayer.style !== 'row' && timelinePrayers.map(p => {
            const top = minToY(p.norm, interval, dayStartH);
            const done = isPrayerDone(p.dateStr, p.key);
            const label = `${p.label} · ${formatTimeLabel(p.minutes, timeFormat)}`;

            if (widgetPrayer.style === 'pill') {
              return (
                <button
                  key={p.id}
                  onClick={() => togglePrayerDone(p.dateStr, p.key)}
                  className="absolute flex items-center gap-1 rounded-md px-1.5 z-20"
                  style={{
                    top, left: 2, right: 2, height: 16,
                    background: `${widgetPrayer.color}26`,
                    border: `1px solid ${widgetPrayer.color}80`,
                    opacity: done ? 0.5 : 1,
                  }}
                  title={label}
                >
                  <span className="flex-shrink-0 flex items-center" style={{ color: widgetPrayer.color }}>
                    {done ? <CheckCircle2 size={9} /> : <Circle size={9} />}
                  </span>
                  <span
                    className="text-[9.5px] font-semibold truncate leading-none"
                    style={{ color: widgetPrayer.color, textDecoration: done ? 'line-through' : 'none' }}
                  >
                    {p.label}
                  </span>
                  <span className="text-[9px] tabular-nums leading-none ml-auto opacity-80" style={{ color: widgetPrayer.color }}>
                    {formatTimeLabel(p.minutes, timeFormat)}
                  </span>
                </button>
              );
            }

            return (
              <div
                key={p.id}
                className="absolute left-0 right-0 z-20 pointer-events-none flex items-center"
                style={{ top: top - 8, height: 16, opacity: done ? 0.45 : 1 }}
              >
                <div
                  className="flex-1 min-w-0"
                  style={{ height: 0, borderTop: `1px solid ${widgetPrayer.color}`, opacity: 0.85 }}
                />
                <button
                  onClick={() => togglePrayerDone(p.dateStr, p.key)}
                  className="flex-shrink-0 flex items-center gap-1 rounded-full pl-1.5 pr-2 pointer-events-auto transition-transform active:scale-95 mx-1 cursor-pointer"
                  style={{
                    height: 15,
                    background: darkMode ? widgetTheme.cardBg : '#ffffff',
                    border: `1px solid ${widgetPrayer.color}80`,
                    boxShadow: `0 1px 3px rgba(0,0,0,${darkMode ? '0.35' : '0.12'})`,
                  }}
                  title={`${label}${done ? ' · done' : ''}`}
                >
                  <span className="flex items-center flex-shrink-0" style={{ color: widgetPrayer.color }}>
                    {done ? <CheckCircle2 size={9} /> : <Circle size={9} />}
                  </span>
                  <span
                    className="text-[9px] font-bold leading-none whitespace-nowrap"
                    style={{ color: widgetPrayer.color, textDecoration: done ? 'line-through' : 'none' }}
                  >
                    {p.label}
                  </span>
                  <span className="text-[8.5px] tabular-nums leading-none opacity-80 whitespace-nowrap" style={{ color: widgetPrayer.color }}>
                    {formatTimeLabel(p.minutes, timeFormat)}
                  </span>
                </button>
                <div
                  className="flex-1 min-w-0"
                  style={{ height: 0, borderTop: `1px solid ${widgetPrayer.color}`, opacity: 0.85 }}
                />
              </div>
            );
          })}

          {/* Events list */}
          {colEvents.map(item => {
            const { ev, key: itemKey, segKind } = item;
            const top = minToY(item.startMin, interval, dayStartH);
            const height = Math.max(18, minToY(item.endMin, interval, dayStartH) - top);
            const { bg, border, text, textMuted, boxShadow, accentBar } = chipColors(ev);
            // Live/duration status always reflects the event's true full start–end, not just this segment.
            const fullStartMin = timeToMin(ev.startTime);
            const fullEndMin   = timeToMin(ev.endTime);
            const sNormEv      = normalizeMin(fullStartMin, dayStartH);
            let eNormEv        = normalizeMin(fullEndMin, dayStartH);
            if (eNormEv <= sNormEv) eNormEv += 1440;
            const spansBoundary = sNormEv < dayStartMin + 1440 && eNormEv > dayStartMin + 1440;
            // "Live" is scoped to this segment's own on-screen range (each segment lives in a
            // different day column, so at most one of tail/head is ever the active one).
            const isLive       = normNowMin >= item.startMin && normNowMin < item.endMin;
            const minutesLeft  = Math.max(0, segKind === 'tail'
              ? fullEndMin + 1440 - normNowMin
              : segKind === 'head'
                ? fullEndMin - normNowMin
                : eNormEv - normNowMin);
            const durationMin  = Math.max(0, eNormEv - sNormEv);
            const isNoDur = Boolean(ev.noDuration || ev.endTime === ev.startTime);
            const timeDisplayStr = isNoDur
              ? formatTimeLabel(fullStartMin, timeFormat)
              : `${formatTimeLabel(fullStartMin, timeFormat)} – ${formatTimeLabel(fullEndMin, timeFormat)}`;
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
                  borderBottomStyle: 'solid',
                  borderTopStyle: 'solid',
                  color: text,
                  boxShadow,
                }}
              >
                {/* Left colour strip — the 'Minimal Left Accent' card style. */}
                {accentBar && (
                  <div
                    className="absolute left-0 top-0 bottom-0 pointer-events-none z-[1]"
                    style={{ width: ACCENT_BAR_W, background: accentBar }}
                  />
                )}
                {(() => {
                  const isMicroCard   = height < 26;
                  const isShortCard   = height >= 26 && height < 44;
                  const isCompactCard = height >= 44 && height < 64;
                  return (
                    <div
                      className={`absolute inset-0 flex flex-col overflow-hidden ${
                        isMicroCard || isShortCard ? 'px-1.5 py-0' : isCompactCard ? 'px-2 py-1' : 'px-2 pt-1.5 pb-1.5'
                      }`}
                      style={{
                        top: isMicroCard ? 1 : isShortCard ? 2 : isCompactCard ? 3 : 4,
                        bottom: isMicroCard ? 1 : isShortCard ? 2 : isCompactCard ? 3 : 4,
                        paddingLeft: accentBar ? ACCENT_BAR_W + 5 : undefined,
                      }}
                    >
                      {(() => {
                        if (isMicroCard) {
                          return (
                            <div className="flex items-center gap-1 w-full h-full my-auto overflow-hidden text-xs px-0.5 leading-none">
                              {!ev.noCheckbox && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleEventCompleted(ev.id);
                                  }}
                                  className="flex-shrink-0 w-3 h-3 rounded-full border transition-smooth duration-150 flex items-center justify-center cursor-pointer"
                                  style={{
                                    borderColor: isCompleted ? text : `${text}50`,
                                    backgroundColor: isCompleted ? text : 'transparent',
                                  }}
                                >
                                  {isCompleted && (
                                    <div className="w-1 h-1 rounded-full" style={{ backgroundColor: bg }} />
                                  )}
                                </button>
                              )}
                              <span className={`text-[10.5px] font-semibold truncate leading-none min-w-0 flex-1 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                                {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic' }}>Untitled</span>}
                              </span>
                              {isNoDur && (
                                <span className="text-[8.5px] font-medium tabular-nums flex-shrink-0 opacity-80 whitespace-nowrap leading-none" style={{ color: textMuted }}>
                                  · {timeDisplayStr}
                                </span>
                              )}
                            </div>
                          );
                        }

                        if (isShortCard) {
                          return (
                            <div className="flex items-center gap-1 w-full h-full my-auto overflow-hidden px-0.5 leading-none">
                              {!ev.noCheckbox && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleEventCompleted(ev.id);
                                  }}
                                  className="flex-shrink-0 w-3 h-3 rounded-full border transition-smooth duration-150 flex items-center justify-center cursor-pointer"
                                  style={{
                                    borderColor: isCompleted ? text : `${text}50`,
                                    backgroundColor: isCompleted ? text : 'transparent',
                                  }}
                                >
                                  {isCompleted && (
                                    <div className="w-1 h-1 rounded-full" style={{ backgroundColor: bg }} />
                                  )}
                                </button>
                              )}
                              <span className={`text-[10px] font-semibold truncate min-w-0 flex-shrink ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                                {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic' }}>Untitled</span>}
                              </span>
                              <span className="text-[8.5px] font-medium tabular-nums flex-shrink-0 opacity-80 whitespace-nowrap leading-none" style={{ color: textMuted }}>
                                · {timeDisplayStr}{isNoDur ? '' : ` (${durationMin < 60 ? `${durationMin}m` : durationLabel})`}
                              </span>
                            </div>
                          );
                        }

                        if (isCompactCard) {
                          return (
                            <div className="flex flex-col justify-between w-full h-full overflow-hidden leading-tight py-0.5">
                              <div className="flex items-center gap-1.5 w-full min-w-0 flex-shrink-0">
                                {!ev.noCheckbox && (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      toggleEventCompleted(ev.id);
                                    }}
                                    className="flex-shrink-0 w-3.5 h-3.5 rounded-full border transition-smooth duration-150 flex items-center justify-center cursor-pointer"
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
                                <span className={`text-[12px] font-semibold truncate leading-tight min-w-0 flex-1 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                                  {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic' }}>Untitled</span>}
                                </span>
                              </div>
                              <span className="text-[9.5px] font-medium tabular-nums flex-shrink-0 opacity-85 leading-none mt-auto flex items-center gap-1 whitespace-nowrap" style={{ color: textMuted }}>
                                {timeDisplayStr}
                                {isLive ? (
                                  <span className="inline-flex items-center gap-0.5" style={{ opacity: 1, color: darkMode ? '#ff8a8a' : '#dc2626' }}>
                                    <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: darkMode ? '#ff8a8a' : '#dc2626' }} />
                                    {minutesLeft}m left
                                  </span>
                                ) : isNoDur ? null : (
                                  <span>({durationLabel})</span>
                                )}
                              </span>
                            </div>
                          );
                        }

                        return (
                          <>
                            {durationMin >= 60 && (
                              <span className="text-[10px] mb-0.5 font-semibold whitespace-nowrap tabular-nums flex-shrink-0 flex items-center justify-center w-full text-center gap-1 opacity-90" style={{ color: textMuted }}>
                                {timeDisplayStr}
                                {isLive ? (
                                  <span className="inline-flex items-center gap-0.5" style={{ opacity: 1, color: darkMode ? '#ff8a8a' : '#dc2626' }}>
                                    <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: darkMode ? '#ff8a8a' : '#dc2626' }} />
                                    {formatTimeLeft(minutesLeft)}
                                  </span>
                                ) : isNoDur ? null : (
                                  <span>({durationLabel})</span>
                                )}
                              </span>
                            )}
                            <div className="flex items-start gap-1.5 flex-1 min-h-0">
                              {!ev.noCheckbox && (
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    toggleEventCompleted(ev.id);
                                  }}
                                  className="flex-shrink-0 mt-0.5 w-3.5 h-3.5 rounded-full border transition-smooth duration-150 flex items-center justify-center cursor-pointer"
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
                              <span className="text-[10.5px] mt-0.5 font-medium whitespace-nowrap tabular-nums flex-shrink-0 flex items-center justify-center w-full text-center gap-1" style={{ color: textMuted }}>
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
                          </>
                        );
                      })()}
                    </div>
                  );
                })()}
                {segKind === 'head' && (
                  <div className="absolute top-0 left-0 right-0 flex items-center justify-center pointer-events-none" style={{ height: 9 }} title={`Continues from ${formatTimeLabel(fullStartMin, timeFormat)} the night before`}>
                    <span style={{ fontSize: 8, lineHeight: 1, opacity: 0.55, color: text }}>⌃ continued</span>
                  </div>
                )}
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

        {/* Bottom spacer padding so the live line can always be centered even near dayEndH or in small windows */}
        <div
          aria-hidden="true"
          className="flex-shrink-0 pointer-events-none"
          style={{ height: '50vh' }}
        />
      </main>

      {/* Floating "Go to Live" Button */}
      {showLiveBtn && (
        <button
          onClick={scrollToLive}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-1.5 px-4 py-2.5 rounded-full text-xs font-semibold shadow-lg backdrop-blur-md transition-smooth duration-300 active:scale-95 animate-in fade-in slide-in-from-bottom-2"
          style={{
            background: darkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.70)',
            border: `1px solid ${darkMode ? 'rgba(255, 255, 255, 0.20)' : 'rgba(0, 0, 0, 0.10)'}`,
            color: '#ffffff',
          }}
        >
          <Clock size={12} />
          <span>Go to Live</span>
          <kbd className="ml-1 px-1.5 py-0.5 text-[10px] font-mono font-bold rounded bg-white/20 text-white/90 uppercase border border-white/20">
            {formatCombo(shortcuts.goToLive)}
          </kbd>
        </button>
      )}
      {/* Overflow Modal Pop-up */}
      <AnimatePresence>
        {overflowModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
            onClick={() => setOverflowModal(null)}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              className="w-full max-w-[280px] rounded-2xl border shadow-2xl p-4 flex flex-col gap-3 max-h-[80vh] overflow-hidden"
              style={{ background: darkMode ? (widgetTheme.cardBg || '#121316') : '#ffffff', borderColor: surfaceBdr }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between border-b pb-2" style={{ borderColor: surfaceBdr }}>
                <span className="text-xs font-bold tracking-tight flex items-center gap-1.5" style={{ color: menuText }}>
                  {overflowModal.type === 'tasks' ? <ListTodo size={13} style={{ color: taskColor }} /> : <Calendar size={13} />}
                  {overflowModal.title} ({overflowModal.items.length})
                </span>
                <button
                  type="button"
                  onClick={() => setOverflowModal(null)}
                  className="w-5 h-5 rounded-full flex items-center justify-center transition-colors hover:bg-white/10"
                  style={{ color: menuSub }}
                >
                  <X size={12} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 pr-0.5 custom-scrollbar max-h-[60vh]">
                {overflowModal.type === 'all-day' && overflowModal.items.map((ev: PlannerEvent) => {
                  const { bg, border, text, accentBar } = chipColors(ev);
                  const dateStr = format(today, 'yyyy-MM-dd');
                  const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(dateStr) ?? false);
                  return (
                    <div
                      key={ev.id}
                      className="px-2.5 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-2 shadow-xs"
                      style={{ backgroundColor: bg, borderColor: border, borderLeft: accentBar ? `3px solid ${accentBar}` : undefined, color: text }}
                    >
                      {!ev.noCheckbox && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleEventCompleted(ev.id);
                          }}
                          className="flex-shrink-0 w-3.5 h-3.5 rounded-full border flex items-center justify-center cursor-pointer"
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
                      <span className={`break-words flex-1 leading-snug ${isCompleted ? 'line-through opacity-60' : ''}`} style={{ color: text }}>
                        {ev.content || 'Untitled'}
                      </span>
                    </div>
                  );
                })}

                {overflowModal.type === 'tasks' && overflowModal.items.map((t: any) => {
                  const occ = t.occDate ?? null;
                  const occId = t.occDate ? `${t.masterId || t.id}::${t.occDate}` : t.id;
                  const done = isTaskDone(t, occ);
                  return (
                    <div
                      key={occId}
                      onClick={() => {
                        const next = toggleTaskDoneHelper(tasks, occId);
                        setTasks(next);
                        localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(next));
                        const url = Object.keys(next).length === 0 ? '/api/tasks?force=1' : '/api/tasks';
                        fetch(url, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(next),
                        }).catch(() => {});
                      }}
                      className="px-2.5 py-1.5 rounded-lg border text-xs font-medium flex items-center gap-2 shadow-2xs cursor-pointer"
                      style={{
                        background: `${taskColor}18`,
                        borderColor: `${taskColor}44`,
                        color: menuText,
                        opacity: done ? 0.5 : 1,
                      }}
                    >
                      <span className="flex-shrink-0 flex items-center" style={{ color: taskColor }}>
                        {done ? (
                          taskCheckboxShape === 'square' ? <CheckSquare size={12} /> : <CheckCircle2 size={12} />
                        ) : (
                          taskCheckboxShape === 'square' ? <Square size={12} /> : <Circle size={12} />
                        )}
                      </span>
                      <span className={`break-words flex-1 leading-snug ${done ? 'line-through opacity-60' : ''}`}>
                        {t.title || 'Untitled task'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
