import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import { createPortal, flushSync } from 'react-dom';
import {
  format,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  differenceInCalendarWeeks,
  endOfMonth,
  eachDayOfInterval,
  isToday,
  isSameMonth,
  isSameDay,
  addDays,
  subDays,
  differenceInDays,
  startOfDay,
} from 'date-fns';
import { ChevronLeft, ChevronRight, X, Moon, Sun, Pencil, CalendarRange, Trash2, Settings, AppWindow, CheckSquare, Undo2, Redo2, Target, BarChart3, Play, Pause, RotateCcw, Plus, Minus, Flame, Award, TrendingUp, Home, Clock, GripHorizontal, Link2, Link2Off, Keyboard, Volume2, Sparkles, AlertTriangle, Edit2, ListTodo, Square, Repeat, StickyNote, CheckCircle2, Circle, ChevronDown, ChevronUp } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  FOCUS_SESSIONS_KEY,
  FOCUS_TIMER_KEY,
  DEFAULT_FOCUS_TIMER,
  type FocusSession,
  type FocusTimerState,
  dateKey,
  focusDayKey,
  formatCountdown,
  formatFocusDuration,
  getFocusTimerElapsedSeconds,
  checkpointFocusTimer,
  pauseFocusTimer,
  loadLocalFocusSessions,
  loadLocalFocusTimer,
  coerceFocusTimer,
  focusTimerPushKey,
  focusTimerIdentity,
  focusTimerTransitionKey,
  isCompletedFocusSession,
  safeFocusSessions,
  sumFocusSecondsForDay,
  uid as focusUid,
  playFocusChime,
  primeFocusAudio,
  coerceFocusChime,
  FOCUS_CHIMES,
  DEFAULT_FOCUS_CHIME,
  type FocusChimeId,
  playFocusCue,
  claimFocusCue,
  focusCueKey,
  coerceFocusCue,
  FOCUS_CUES,
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

function parseDurationInput(str: string): number {
  const cleaned = str.trim().toLowerCase();
  if (!cleaned || cleaned === '0' || cleaned === '—' || cleaned === '-') return 0;

  if (cleaned.includes(':')) {
    const parts = cleaned.split(':');
    const h = parseInt(parts[0], 10) || 0;
    const m = parseInt(parts[1], 10) || 0;
    return (h * 60 + m) * 60;
  }

  if (cleaned.includes('h') || cleaned.includes('m')) {
    let totalSec = 0;
    const hMatch = cleaned.match(/([\d.]+)\s*h/);
    const mMatch = cleaned.match(/([\d.]+)\s*m/);
    if (hMatch) totalSec += Math.round(parseFloat(hMatch[1]) * 3600);
    if (mMatch) totalSec += Math.round(parseFloat(mMatch[1]) * 60);
    return totalSec;
  }

  if (cleaned.includes('.')) {
    const hours = parseFloat(cleaned);
    return isNaN(hours) ? 0 : Math.round(hours * 3600);
  }

  const num = parseInt(cleaned, 10);
  if (isNaN(num) || num <= 0) return 0;
  if (num <= 12) {
    return num * 3600;
  } else {
    return num * 60;
  }
}

function formatDetailedDuration(seconds: number): string {
  if (seconds <= 0) return '0 minutes (Cleared)';
  const totalMins = Math.round(seconds / 60);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;

  if (hours > 0 && mins > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}, ${mins} minute${mins === 1 ? '' : 's'} (${totalMins} mins total)`;
  } else if (hours > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'} (${totalMins} mins total)`;
  } else {
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
}

function formatTimeLeft(mins: number): string {
  if (mins <= 0) return '0m left';
  if (mins < 60) return `${mins}m left`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${h}h left` : `${h}h ${m}m left`;
}
import {
  type ShortcutAction,
  type ShortcutMap,
  SHORTCUT_DEFS,
  DEFAULT_SHORTCUTS,
  SHORTCUTS_KEY,
  eventToCombo,
  matchesCombo,
  formatCombo,
  coerceShortcuts,
  loadShortcuts,
  findConflicts,
  isReservedCombo,
} from '@/lib/shortcuts';
import {
  type Recurrence,
  type RecurFreq,
  type Weekday,
  type DeleteMode,
  weekKeyOf,
  migrateEvents,
  resolveWeek,
  editSeries,
  deleteScoped,
  stampNewItem,
  parseOccId,
  parseDate,
  getEventWeekOverlap,
} from '@/lib/recurrence';
import { gcalChipColors, resolveEventHex, SWATCH_BASE_HEX } from '@/lib/gcalColor';
import TasksPanel, { type NewTaskInput, type TaskTheme } from '@/components/TasksPanel';
import {
  broadcastSettingsChange,
  subscribeSettingsChange,
  loadSettingsLocal,
  applyDarkModeClass,
  coerceSettings,
  themePalette,
  type DarkPreset,
  type LightPreset,
  type EventCardStyle,
  type SidebarStyle,
  type AppSettings,
  TASK_PANEL_MIN_W,
  TASK_PANEL_MAX_W,
} from '@/lib/settingsSync';
import {
  type Task,
  type TaskData,
  type TaskFilter,
  ALL_TASK_FILTERS,
  canonicalFilters,
  coerceTasks,
  composeTaskNotes,
  deleteTaskScoped,
  dueDateOf,
  editTaskSeries,
  isTaskDone,
  makeTask,
  resolveWeekTasks,
  TASKS_STORAGE_KEY,
  taskKind,
  toggleTaskDone,
  todayYmd,
  withDueDate,
  withTime,
} from '@/lib/tasks';
import {
  buildPrayerDay,
  coercePrayerSettings,
  prayerDateKey,
  type PrayerOccurrence,
  type PrayerSettings,
} from '@/lib/prayerTimes';
import { usePrayerTimes } from '@/lib/usePrayerTimes';

/** Per-service sync health as reported by /api/google-auth/status. */
interface SyncLeg {
  lastRunAt: number;
  lastOkAt: number;
  pushed: number;
  incomplete: boolean;
  error: string | null;
  skipped?: string | null;
}

/** "Calendar: synced 3 min ago" / "Tasks: <what went wrong>". */
function syncHealthLabel(name: string, leg?: SyncLeg): string {
  if (!leg) return `${name}: no sync yet`;
  if (leg.error) return `${name}: ${leg.error}`;
  if (leg.skipped) return `${name}: ${leg.skipped}`;
  if (!leg.lastOkAt) return `${name}: no successful sync yet`;
  const mins = Math.floor((Date.now() - leg.lastOkAt) / 60000);
  const ago = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : `${Math.floor(mins / 60)}h ago`;
  return `${name}: synced ${ago}`;
}

// Dated-task band under All Day.
const TASK_CHIP_H = 22;
const TASK_ROW_MIN_H = 30;
// Prayer band, when prayers are set to render in their own row.
const PRAYER_CHIP_H = 17;
const PRAYER_ROW_MIN_H = 28;

const clampPanelWidth = (w: number) =>
  Math.max(TASK_PANEL_MIN_W, Math.min(TASK_PANEL_MAX_W, Math.round(Number.isFinite(w) ? w : 340)));

// â”€â”€â”€ TEMP DEBUG: surface the real error the overlay hides â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (typeof window !== 'undefined' && !(window as any).__errDbg) {
  (window as any).__errDbg = true;
  window.addEventListener('error', (e) => {
    // eslint-disable-next-line no-console
    console.log('%c[DBG error]', 'color:#e11', {
      message: e.message,
      filename: e.filename,
      line: e.lineno,
      col: e.colno,
      errorType: e.error?.constructor?.name ?? typeof e.error,
      stack: e.error?.stack ?? '(no stack — likely ResizeObserver / cross-origin)',
    });
  }, true);
  window.addEventListener('unhandledrejection', (e) => {
    const r: any = e.reason;
    // eslint-disable-next-line no-console
    console.log('%c[DBG unhandledrejection]', 'color:#e11', {
      reasonType: r?.constructor?.name ?? typeof r,
      reason: r,
      stack: r?.stack ?? '(no stack)',
    });
  });
}

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
type IntervalMin   = 5 | 15 | 30 | 60;
type EventColor    = 'sage' | 'peach' | 'blue' | 'sand' | 'lilac' | 'rose' | 'teal' | 'lavender' | 'emerald' | 'coral' | string;
type TimeFormat    = '12h' | '24h';
type WeekStartsOn  = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun … 6=Sat

// Calendar zoom levels, narrowest â†’ widest. Ctrl+wheel steps along this axis.
type CalendarView = 'day' | 'week' | 'month' | 'year' | 'custom';
const CALENDAR_VIEWS: CalendarView[] = ['day', 'week', 'month', 'year'];
// 'custom' sits outside the zoom axis (it has its own width) but is still a
// selectable view in the toolbar.
const CALENDAR_VIEW_BUTTONS: CalendarView[] = [...CALENDAR_VIEWS, 'custom'];
const isCalendarView = (v: unknown): v is CalendarView =>
  typeof v === 'string' && (CALENDAR_VIEW_BUTTONS as string[]).includes(v);

// Custom view window: P days BEFORE the week start + N days FROM the week start.
// P=1,N=7 with a Sunday week start = Saturday → next Saturday (8 columns).
const CUSTOM_BEFORE_MAX = 7;
const CUSTOM_AFTER_MIN  = 1;
const CUSTOM_AFTER_MAX  = 14;

// App zoom: a fine 5% step, clamped to something still usable at both ends.
const ZOOM_MIN  = 0.5;
const ZOOM_MAX  = 2.0;
const ZOOM_STEP = 0.05;
const ZOOM_KEY  = 'planner-app-zoom';
const clampZoom = (z: number) =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(z / ZOOM_STEP) * ZOOM_STEP));

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
  // â”€â”€ Recurrence (Google-style, see src/lib/recurrence.ts) â”€â”€
  weekKey?: string;            // week-start date of the anchor (first) occurrence
  recur?: Recurrence;          // absent = does not repeat
  exdates?: string[];          // 'yyyy-MM-dd' occurrence dates removed individually
  locked?: boolean;            // repeating master: edits/moves apply to whole series (default off)
  // ── Linking ("coupled like train carriages") ────────────────────────────────
  // Items sharing a `linkGroup` move as one: dragging any of them drags the rest
  // by the same delta, and dragging one's START edge shifts the rest too, so a
  // "Get Up" chip stays welded to the front of the "Sleeping" block it precedes.
  // Durations are never changed — only positions. Series-level (see editSeries).
  linkGroup?: string;
  deleted?: boolean;           // tombstone awaiting a Google-side delete, then removal
  // View-only, stamped onto expanded occurrences (never persisted):
  masterId?: string;
  occDate?: string;
}

type PlannerData = Record<string, PlannerEvent>;

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

const EVENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  sage:     { bg: '#dcfce7', border: '#86efac', text: '#14532d' },
  peach:    { bg: '#ffedd5', border: '#fdba74', text: '#7c2d12' },
  blue:     { bg: '#dbeafe', border: '#93c5fd', text: '#1e3a8a' },
  sand:     { bg: '#fef3c7', border: '#fcd34d', text: '#78350f' },
  lilac:    { bg: '#f3e8ff', border: '#d8b4fe', text: '#581c87' },
  rose:     { bg: '#ffe4e6', border: '#fda4af', text: '#9f1239' },
  teal:     { bg: '#ccfbf1', border: '#5eead4', text: '#115e59' },
  lavender: { bg: '#e0e7ff', border: '#a5b4fc', text: '#3730a3' },
  emerald:  { bg: '#d1fae5', border: '#6ee7b7', text: '#065f46' },
  coral:    { bg: '#ffe4e1', border: '#fca5a5', text: '#991b1b' },
};

const VIVID_DARK_EVENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  sage:     { bg: '#163523', border: '#22c55e', text: '#4ade80' },
  peach:    { bg: '#3a2016', border: '#f97316', text: '#fb923c' },
  blue:     { bg: '#162846', border: '#3b82f6', text: '#60a5fa' },
  sand:     { bg: '#332b14', border: '#eab308', text: '#facc15' },
  lilac:    { bg: '#2b193f', border: '#a855f7', text: '#c084fc' },
  rose:     { bg: '#3b1622', border: '#f43f5e', text: '#fb7185' },
  teal:     { bg: '#123332', border: '#14b8a6', text: '#2dd4bf' },
  lavender: { bg: '#1e2448', border: '#6366f1', text: '#818cf8' },
  emerald:  { bg: '#103829', border: '#10b981', text: '#34d399' },
  coral:    { bg: '#3f1818', border: '#ef4444', text: '#f87171' },
};

const CLASSIC_DARK_EVENT_COLORS: Record<string, { bg: string; border: string; text: string }> = {
  sage:     { bg: '#182818', border: '#365e30', text: '#8ec88e' },
  peach:    { bg: '#2e1810', border: '#6e3820', text: '#d48060' },
  blue:     { bg: '#101c30', border: '#284878', text: '#78aadd' },
  sand:     { bg: '#261e0e', border: '#6a4e28', text: '#c8a860' },
  lilac:    { bg: '#1e1228', border: '#523070', text: '#b07ecc' },
  rose:     { bg: '#2b141b', border: '#6e2838', text: '#d46078' },
  teal:     { bg: '#102625', border: '#255953', text: '#60c4b8' },
  lavender: { bg: '#161a33', border: '#353a70', text: '#7a82c4' },
  emerald:  { bg: '#10261e', border: '#245e45', text: '#60c496' },
  coral:    { bg: '#2d1414', border: '#6e2828', text: '#d46060' },
};

const SWATCHES: EventColor[] = ['sage', 'peach', 'blue', 'sand', 'lilac', 'rose', 'teal', 'lavender', 'emerald', 'coral'];


function matchPresetColor(hex: string | undefined): EventColor | null {
  if (!hex || typeof hex !== 'string') return null;
  const clean = hex.trim().toLowerCase();
  for (const sw of SWATCHES) {
    if (SWATCH_BASE_HEX[sw]?.toLowerCase() === clean) return sw;
    const l = EVENT_COLORS[sw];
    const v = VIVID_DARK_EVENT_COLORS[sw];
    const c = CLASSIC_DARK_EVENT_COLORS[sw];
    if ([l?.border, l?.bg, l?.text, v?.border, v?.bg, v?.text, c?.border, c?.bg, c?.text].some(h => h && h.toLowerCase() === clean)) {
      return sw;
    }
  }
  return null;
}

// â”€â”€â”€ Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ All-Day Layout Stacking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function layoutAllDay(events: Array<PlannerEvent & { visibleDayIndex: number; visibleDaysSpan: number }>): Map<string, { row: number }> {
  const sorted = [...events].sort((a, b) => {
    const spanA = a.visibleDaysSpan;
    const spanB = b.visibleDaysSpan;
    if (spanA !== spanB) return spanB - spanA;
    return a.visibleDayIndex - b.visibleDayIndex;
  });

  const rowTracking: number[][] = [];
  const layoutMap = new Map<string, number>();

  for (const ev of sorted) {
    const start = ev.visibleDayIndex;
    const end = start + ev.visibleDaysSpan;

    let assignedRow = 0;
    while (true) {
      if (!rowTracking[assignedRow]) {
        rowTracking[assignedRow] = [];
      }
      const overlap = rowTracking[assignedRow].some(dayIdx => dayIdx >= start && dayIdx < end);
      if (!overlap) {
        for (let d = start; d < end; d++) {
          rowTracking[assignedRow].push(d);
        }
        layoutMap.set(ev.id, assignedRow);
        break;
      }
      assignedRow++;
    }
  }

  const result = new Map<string, { row: number }>();
  for (const [id, r] of layoutMap.entries()) {
    result.set(id, { row: r });
  }
  return result;
}



// â”€â”€â”€ Parallel layout â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Returns a map of eventId â†’ { col, numCols } for events within a single day column.
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

// â”€â”€â”€ Recurrence editor â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Google-style repeat controls: a preset row (Does not repeat / Daily / Weekly /
// Monthly / Yearly / Custom) plus, when Custom, an interval + unit, weekday chips
// (weekly), and an end condition (Never / On date / After N).
interface RecurTheme { text: string; sub: string; bdr: string; hover: string; accent: string; accentBg: string; fieldBg: string; }
function RecurrenceEditor({ recur, anchorWeekday, onChange, theme }: {
  recur: Recurrence | undefined;
  anchorWeekday: Weekday;
  onChange: (r: Recurrence | undefined) => void;
  theme: RecurTheme;
}) {
  const [custom, setCustom] = useState(false);
  // Which preset is active for the current rule.
  const preset: string = !recur ? 'none'
    : recur.freq === 'daily' && recur.interval === 1 && !recur.end ? 'daily'
    : recur.freq === 'weekly' && recur.interval === 1 && !recur.end && (recur.byWeekday?.length ?? 1) <= 1 ? 'weekly'
    : recur.freq === 'monthly' && recur.interval === 1 && !recur.end ? 'monthly'
    : recur.freq === 'yearly' && recur.interval === 1 && !recur.end ? 'yearly'
    : 'custom';
  const showCustom = custom || preset === 'custom';

  const setPreset = (p: string) => {
    setCustom(false);
    if (p === 'none') return onChange(undefined);
    if (p === 'daily') return onChange({ freq: 'daily', interval: 1 });
    if (p === 'weekly') return onChange({ freq: 'weekly', interval: 1, byWeekday: [anchorWeekday] });
    if (p === 'monthly') return onChange({ freq: 'monthly', interval: 1 });
    if (p === 'yearly') return onChange({ freq: 'yearly', interval: 1 });
    if (p === 'custom') { setCustom(true); onChange(recur ?? { freq: 'weekly', interval: 1, byWeekday: [anchorWeekday] }); }
  };

  const r: Recurrence = recur ?? { freq: 'weekly', interval: 1 };
  const patch = (d: Partial<Recurrence>) => onChange({ ...r, ...d });
  const endType: 'never' | 'until' | 'count' = !r.end ? 'never' : 'count' in r.end ? 'count' : 'until';

  const chip = (active: boolean): React.CSSProperties => ({
    padding: '3px 9px', borderRadius: 7, fontSize: 11, fontWeight: 600, cursor: 'pointer',
    background: active ? theme.accentBg : 'transparent', color: active ? theme.accent : theme.sub,
    border: `1px solid ${active ? theme.accent : theme.bdr}`,
  });
  const field: React.CSSProperties = { background: theme.fieldBg, color: theme.text, border: `1px solid ${theme.bdr}`, borderRadius: 6, padding: '2px 6px', fontSize: 11 };

  const presets: Array<[string, string]> = [['none', "Doesn't repeat"], ['daily', 'Daily'], ['weekly', 'Weekly'], ['monthly', 'Monthly'], ['yearly', 'Yearly'], ['custom', 'Custom…']];
  const WD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

  return (
    <div className="px-3 py-2.5" style={{ borderBottom: `1px solid ${theme.bdr}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: theme.sub }}>Repeat</span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
        {presets.map(([v, label]) => (
          <button key={v} type="button" onClick={() => setPreset(v)} style={chip(v === 'custom' ? showCustom : preset === v)}>{label}</button>
        ))}
      </div>

      {showCustom && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 2 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', color: theme.text, fontSize: 11 }}>
            <span>Every</span>
            <input type="number" min={1} value={r.interval} onChange={e => patch({ interval: Math.max(1, parseInt(e.target.value || '1', 10)) })} style={{ ...field, width: 46 }} />
            <select value={r.freq} onChange={e => patch({ freq: e.target.value as RecurFreq })} style={field}>
              <option value="daily">day(s)</option>
              <option value="weekly">week(s)</option>
              <option value="monthly">month(s)</option>
              <option value="yearly">year(s)</option>
            </select>
          </div>

          {r.freq === 'weekly' && (
            <div style={{ display: 'flex', gap: 4 }}>
              {WD.map((d, i) => {
                const days = r.byWeekday ?? [anchorWeekday];
                const on = days.includes(i as Weekday);
                return (
                  <button key={i} type="button" title={['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][i]}
                    onClick={() => {
                      const next = on ? days.filter(x => x !== i) : [...days, i as Weekday];
                      patch({ byWeekday: (next.length ? next : [anchorWeekday]).sort((a, b) => a - b) });
                    }}
                    style={{ ...chip(on), width: 24, padding: '3px 0', textAlign: 'center' }}>{d}</button>
                );
              })}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', color: theme.text, fontSize: 11 }}>
            <span>Ends</span>
            <select value={endType} onChange={e => {
              const v = e.target.value;
              if (v === 'never') patch({ end: undefined });
              else if (v === 'count') patch({ end: { count: 10 } });
              else patch({ end: { until: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) } });
            }} style={field}>
              <option value="never">Never</option>
              <option value="until">On date</option>
              <option value="count">After…</option>
            </select>
            {endType === 'until' && r.end && 'until' in r.end && (
              <input type="date" value={r.end.until} onChange={e => patch({ end: { until: e.target.value } })} style={field} />
            )}
            {endType === 'count' && r.end && 'count' in r.end && (
              <>
                <input type="number" min={1} value={r.end.count} onChange={e => patch({ end: { count: Math.max(1, parseInt(e.target.value || '1', 10)) } })} style={{ ...field, width: 46 }} />
                <span>occurrence(s)</span>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// â”€â”€â”€ Main Component â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export default function WeeklyPlanner() {
  // Initialize state from local settings cache for instant display
  const initialSettings = useRef(loadSettingsLocal()).current;

  const [currentDate, setCurrentDate] = useState(new Date());
  const [interval, setIntervalOpt]    = useState<IntervalMin>(initialSettings.interval);
  const [events, setEvents]           = useState<PlannerData>({});
  // Tasks live in their own store (database/tasks.json) and sync to Google TASKS,
  // never to Google Calendar. See lib/tasks.ts for why they aren't PlannerEvents.
  const [tasks, setTasks]             = useState<TaskData>({});
  // True until the first load (localStorage or backend) has resolved, so the grid
  // can show a skeleton instead of flashing an empty week.
  const [eventsLoading, setEventsLoading] = useState(true);
  // Automated backups — the dev server writes snapshots into <root>/backups on
  // this schedule; these are just the knobs, persisted with the other settings.
  type AutoBackupCfg = { enabled: boolean; intervalHours: number; keep: number };
  const AUTO_BACKUP_DEFAULT: AutoBackupCfg = { enabled: true, intervalHours: 24, keep: 50 };
  const coerceAutoBackup = (raw: unknown): AutoBackupCfg => {
    const cfg = { ...AUTO_BACKUP_DEFAULT };
    if (raw && typeof raw === 'object') {
      const r = raw as Record<string, unknown>;
      if (typeof r.enabled === 'boolean') cfg.enabled = r.enabled;
      const h = Number(r.intervalHours);
      if (Number.isFinite(h) && h >= 1) cfg.intervalHours = Math.min(720, Math.round(h));
      const k = Number(r.keep);
      if (Number.isFinite(k) && k >= 1) cfg.keep = Math.min(1000, Math.round(k));
    }
    return cfg;
  };
  const [autoBackup, setAutoBackup] = useState<AutoBackupCfg>(initialSettings.autoBackup);
  const [backupStatus, setBackupStatus] = useState<{ count: number; lastBackupAt: string | null } | null>(null);
  // User-rebindable keyboard shortcuts (see lib/shortcuts.ts).
  const [shortcuts, setShortcuts]     = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  const shortcutsRef                  = useRef<ShortcutMap>(DEFAULT_SHORTCUTS);
  useEffect(() => { shortcutsRef.current = shortcuts; }, [shortcuts]);
  const [showShortcutHelp, setShowShortcutHelp] = useState(false);
  const [recordingAction, setRecordingAction]   = useState<ShortcutAction | null>(null);
  const recordingActionRef = useRef<ShortcutAction | null>(null);
  useEffect(() => { recordingActionRef.current = recordingAction; }, [recordingAction]);
  const showShortcutHelpRef = useRef(false);
  useEffect(() => { showShortcutHelpRef.current = showShortcutHelp; }, [showShortcutHelp]);
  // Late-bound handles for the shortcut runner: the global keydown effect is set
  // up long before these functions exist, so it calls through this ref instead.
  const navRef = useRef({
    prev: () => {}, next: () => {}, today: () => {}, goToLive: () => {},
    toggleView: () => {}, toggleAnalysis: () => {}, toggleSettings: () => {},
    openWidget: () => {}, newEvent: () => {}, toggleTimer: () => {}, toggleHelp: () => {},
  });
  // Lightweight toasts — replaces blocking window.alert() for import/export/sync
  // feedback so nothing ever freezes the UI mid-action.
  type Toast = { id: number; message: string; tone: 'info' | 'success' | 'error' };
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);
  const showToast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastSeq.current;
    setToasts(prev => [...prev.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4200);
  }, []);
  const [editingId, setEditingId]     = useState<string | null>(null);
  const [hoveredId, setHoveredId]     = useState<string | null>(null);
  const [menuId, setMenuId]           = useState<string | null>(null);
  const [menuPos, setMenuPos]         = useState<{ x: number; y: number } | null>(null);
  const [deleteExpanded, setDeleteExpanded] = useState(false); // "Delete more…" sub-options
  useEffect(() => { setDeleteExpanded(false); }, [menuId]);
  // A brand-new item started from the dedicated "ï¼‹" button lives here as an
  // uncommitted DRAFT — it is NOT in `events` and never touches the grid/Google
  // until the user presses Save. All popup field edits route into it (see applyEdit).
  const [draft, setDraft] = useState<PlannerEvent | null>(null);
  const draftRef = useRef<PlannerEvent | null>(null);
  useEffect(() => { draftRef.current = draft; }, [draft]);
  // Whether the user has hand-placed the popup (dragged it, or it opened centered).
  // While pinned, auto-anchoring to the event is suspended.
  const [menuPinned, setMenuPinned] = useState(false);
  const menuPinnedRef = useRef(false);
  useEffect(() => { menuPinnedRef.current = menuPinned; }, [menuPinned]);
  // Discard the draft / unpin whenever the popup closes by any path.
  useEffect(() => { if (menuId === null) { setDraft(null); setMenuPinned(false); } }, [menuId]);
  const [location, setLocation] = useLocation();
  // The settings page is an overlay drawn on top of this one, which stays mounted.
  // While it is open the planner must not scroll or show its own scrollbar.
  const settingsRouteOpen = location === '/settings';
  const [direction, setDirection]     = useState(0);

  const [darkMode, setDarkMode]             = useState<boolean>(initialSettings.darkMode);
  const [darkPreset, setDarkPreset]         = useState<DarkPreset>(initialSettings.darkPreset);
  const [lightPreset, setLightPreset]       = useState<LightPreset>(initialSettings.lightPreset);
  // Owned by the side window; the main window only carries them so saving here
  // never drops the side window's choice.
  const [widgetDarkPreset, setWidgetDarkPreset]   = useState<DarkPreset>(initialSettings.widgetDarkPreset);
  const [widgetLightPreset, setWidgetLightPreset] = useState<LightPreset>(initialSettings.widgetLightPreset);
  const [eventColorStyle, setEventColorStyle] = useState<EventCardStyle>(initialSettings.eventColorStyle);
  const [sidebarStyle, setSidebarStyle]     = useState<SidebarStyle>(initialSettings.sidebarStyle);
  const [timeFormat, setTimeFormat]         = useState<TimeFormat>(initialSettings.timeFormat);
  const [weekStartsOn, setWeekStartsOn]     = useState<WeekStartsOn>(initialSettings.weekStartsOn);
  // Zoom levels, narrowest â†’ widest. Ctrl+wheel steps through them.
  const [calendarView, setCalendarView] = useState<CalendarView>('week');
  // Custom view: P days before the week start, N days from the week start.
  const [customDaysBefore, setCustomDaysBefore] = useState<number>(initialSettings.customDaysBefore);
  const [customDaysAfter, setCustomDaysAfter]   = useState<number>(initialSettings.customDaysAfter);
  // App zoom (NOT browser zoom): Ctrl +/- and the header stepper drive this, and
  // it's applied as CSS `zoom` on the root so layout reflows instead of blurring.
  const [appZoom, setAppZoom] = useState(1);
  const [zoomDraft, setZoomDraft] = useState('100');
  const [editingZoom, setEditingZoom] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // â”€â”€ Tasks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const [tasksPanelOpen, setTasksPanelOpen]   = useState<boolean>(initialSettings.tasksPanelOpen);
  const [tasksPanelWidth, setTasksPanelWidth] = useState<number>(initialSettings.tasksPanelWidth);
  const [showTaskRow, setShowTaskRow]         = useState<boolean>(initialSettings.showTaskRow);
  const [taskColor, setTaskColor]             = useState<string>(initialSettings.taskColor);
  const [prayer, setPrayer]                   = useState<PrayerSettings>(initialSettings.prayer);
  const [prayerPanelOpen, setPrayerPanelOpen] = useState(false);
  const prayerPanelRef                        = useRef<HTMLDivElement>(null);
  const [taskCheckboxShape, setTaskCheckboxShape] = useState<any>(initialSettings.taskCheckboxShape ?? 'circle');
  const [taskFilters, setTaskFilters]         = useState<TaskFilter[]>(canonicalFilters(initialSettings.taskFilters));
  const [googleTasksSync, setGoogleTasksSync] = useState<boolean>(initialSettings.googleTasksSync);
  const [taskMenuId, setTaskMenuId]   = useState<string | null>(null);
  const [taskMenuPos, setTaskMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [selRect, setSelRect]           = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [batchDisp, setBatchDisp]       = useState<{ [id: string]: { dayIndex: number; startMin: number } } | null>(null);
  const [nowTick, setNowTick]           = useState(Date.now());
  const [dayStartH, setDayStartH]       = useState(initialSettings.dayStartH);
  const [dayEndH, setDayEndH]           = useState(initialSettings.dayEndH);
  const [focusSessions, setFocusSessions] = useState<FocusSession[]>([]);
  // Hour (0–23, local) at which a new "focus day" begins. Sessions before this hour
  // count toward the previous day. Purely a bucketing setting — all analysis derives
  // from it live, so changing it re-buckets past sessions on the fly.
  const [focusDayStartHour, setFocusDayStartHour] = useState(3);
  const [focusChime, setFocusChime] = useState<FocusChimeId>(DEFAULT_FOCUS_CHIME);
  // The completion effect is set up once; read the current choice through a ref.
  const focusChimeRef = useRef<FocusChimeId>(DEFAULT_FOCUS_CHIME);
  useEffect(() => { focusChimeRef.current = focusChime; }, [focusChime]);
  // Start / pause / resume cues. Any slot may be 'none' for silence.
  const [focusCues, setFocusCues] = useState<Record<FocusCueSlot, FocusCueId>>({ ...DEFAULT_FOCUS_CUES });
  const focusCuesRef = useRef(focusCues);
  useEffect(() => { focusCuesRef.current = focusCues; }, [focusCues]);
  // Browsers block audio until the page has seen a gesture. Unlock on the first
  // one so the completion chime fires instantly instead of warming up first.
  useEffect(() => {
    // Stays attached rather than unhooking after the first gesture: the context
    // can be put back to sleep later, and a re-warm on every interaction is free.
    const unlock = () => primeFocusAudio();
    unlock();
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('focus', unlock);
    return () => {
      window.removeEventListener('focus', unlock);
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);
  const [focusTimer, setFocusTimer]       = useState<FocusTimerState>(DEFAULT_FOCUS_TIMER);
  const [editingFocusMinutes, setEditingFocusMinutes] = useState(false);
  const [focusMinutesDraft, setFocusMinutesDraft]     = useState('60');
  const focusCompleteRef = useRef(false);
  // Brief victory flourish on the timer when a session completes naturally.
  const [focusCelebrate, setFocusCelebrate] = useState(false);
  const [showFocusAnalysis, setShowFocusAnalysis] = useState(false);
  const [analysisTab, setAnalysisTab]       = useState<'week' | 'month' | 'year'>('week');
  const [analysisWeekCursor, setAnalysisWeekCursor]   = useState(() => new Date());
  const [analysisMonthCursor, setAnalysisMonthCursor] = useState(() => new Date());
  const [analysisYearCursor, setAnalysisYearCursor]   = useState(() => new Date().getFullYear());
  const [editingFocusDayKey, setEditingFocusDayKey]   = useState<string | null>(null);
  const [editingFocusInput, setEditingFocusInput]     = useState<string>('');
  const [confirmFocusModal, setConfirmFocusModal]     = useState<{
    date: Date;
    dateKey: string;
    label: string;
    oldSeconds: number;
    newSeconds: number;
  } | null>(null);
  // Google Calendar Integration State
  const [gCalStatus, setGCalStatus] = useState<{
    configured: boolean;
    authenticated: boolean;
    email?: string;
    autoSync?: boolean;
    clientId?: string;
    clientSecret?: string;
    // False for tokens minted before Tasks support — every Tasks call with one
    // returns 403, so a reconnect is required before tasks sync can run.
    hasTasksScope?: boolean;
    // Google has rejected the stored authorisation (expired/revoked refresh
    // token). Only a reconnect fixes it, so we surface it instead of retrying
    // forever behind a spinner that says "Syncing".
    needsReconnect?: boolean;
    authError?: string | null;
    health?: {
      auth: { ok: boolean; needsReconnect: boolean; error: string | null; at: number };
      calendar: SyncLeg;
      tasks: SyncLeg & { skipped?: string | null };
    };
  }>({ configured: false, authenticated: false });
  const [gCalSyncing, setGCalSyncing] = useState(false);
  const gCalHealth = gCalStatus.health;
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');

  const handleHeaderCreateClick = (_e?: React.MouseEvent<HTMLButtonElement>) => {
    setSelectedIds(new Set());
    setMenuId(null);

    // Default dayIndex matching today relative to weekStartsOn setting
    const todayIdx = (new Date().getDay() - weekStartsOn + 7) % 7;

    // Default hours clamped to calendar views (7:00 AM to 11:00 PM)
    const currentHour = new Date().getHours();
    const startHour = Math.min(23, Math.max(7, currentHour));
    const startTime = minToTime(startHour * 60);
    const endTime = minToTime((startHour + 1) * 60);

    // Build a fully-anchored DRAFT (stamped to the viewed week) but do NOT add it to
    // `events` — it stays out of the grid/Google until the user presses Save.
    const base = stampNewItem(
      { id: uid(), dayIndex: todayIdx, startTime, endTime, content: '', color: 'sage' } as PlannerEvent,
      editCtxRef.current.viewedWeekKey, editCtxRef.current.weekStartsOn,
    );
    setDraft(base);
    // Open the popup centred and pinned so it stays put (no event to anchor to yet).
    const w = 300, h = 480;
    setMenuPinned(true);
    menuPinnedRef.current = true;
    setMenuId(base.id);
    setMenuPos({
      x: Math.max(8, Math.round((window.innerWidth - w) / 2)),
      y: Math.max(8, Math.round((window.innerHeight - h) / 2)),
    });
  };

  const dragRef = useRef<{
    eventId: string; durationMin: number; offsetMin: number; isHeadClick?: boolean;
    origDay: number; curDay: number; curStartMin: number;
    active: boolean; initX: number; initY: number;
  } | null>(null);

  const resizeRef = useRef<{
    eventId: string; edge: 'top' | 'bottom'; startMin: number; endMin: number;
    isHeadClick?: boolean; isTailClick?: boolean;
    /** Where the start edge began, so a linked train can be shifted by the delta. */
    baseStartMin: number;
    /** Linked partners captured at gesture start (top-edge resizes only). */
    linkBase: Record<string, { dayIndex: number; startMin: number; durationMin: number }>;
  } | null>(null);

  const [dragDisp, setDragDisp]     = useState<{ id: string; day: number; startMin: number } | null>(null);
  const [dragDelta, setDragDelta]   = useState<{ x: number; y: number } | null>(null);
  const [resizeDisp, setResizeDisp] = useState<{ id: string; startMin: number; endMin: number } | null>(null);
  const [clipboard, setClipboard]   = useState<PlannerEvent[]>([]);

  const daysGridRef  = useRef<HTMLDivElement>(null);
  const mainRef      = useRef<HTMLDivElement>(null);
  const nowLineRef   = useRef<HTMLDivElement>(null);
  const [showLiveBtn, setShowLiveBtn] = useState(false);
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
  // Live start/end of the block being drag-created, so the times can be shown
  // while the drag is still in progress (not just after it commits).
  const [createDisp, setCreateDisp] = useState<{ startMin: number; endMin: number } | null>(null);
  const didDragRef     = useRef(false);
  const editingIdRef = useRef<string | null>(null);
  const hoveredIdRef = useRef<string | null>(null);
  const menuIdRef    = useRef<string | null>(null);
  const menuPosRef   = useRef<{ x: number; y: number } | null>(null);
  const eventsRef    = useRef<PlannerData>({});
  const tasksRef     = useRef<TaskData>({});
  const tasksLoadedRef = useRef(false);
  // Guards Google sync from running before the initial events load has resolved —
  // syncing an empty map would push a truncated database back to disk (data loss).
  const eventsLoadedRef = useRef(false);
  const dayStartRef  = useRef(7);
  const dayEndRef    = useRef(31);
  const clipboardRef = useRef<PlannerEvent[]>([]);
  const mousePosRef  = useRef<{ x: number; y: number } | null>(null);
  const autoScrollTimerRef = useRef<number | null>(null);
  const autoScrollLastPosRef = useRef<{ clientX: number; clientY: number } | null>(null);

  // Keep the popup glued to its event: recompute its position from the live
  // element rect on scroll/resize/content-change (instead of letting it drift or
  // closing it). Clamps into the viewport so the whole (comprehensive) popup
  // stays reachable; the popup itself scrolls if it's taller than the screen.
  const repositionMenu = useCallback(() => {
    const menuEl = menuRef.current;
    const id = menuIdRef.current;
    if (!menuEl || !id) return;
    const margin = 8;
    const mw = menuEl.offsetWidth || 200;
    const mh = menuEl.offsetHeight || 300;
    const anchor = document.querySelector(`[data-event-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`) as HTMLElement | null;
    let x: number, y: number;
    if (menuPinnedRef.current) {
      // Hand-placed (dragged or centered): keep where it is, only re-clamp into view.
      x = menuEl.offsetLeft;
      y = menuEl.offsetTop;
    } else if (anchor) {
      const r = anchor.getBoundingClientRect();
      x = r.right + 6;                                   // prefer right of the block
      if (x + mw > window.innerWidth - margin) x = r.left - mw - 6; // flip left near edge
      y = r.top;
    } else {
      const p = menuPosRef.current;                      // fallback: last known point
      x = p?.x ?? margin;
      y = p?.y ?? margin;
    }
    x = Math.max(margin, Math.min(x, window.innerWidth - mw - margin));
    y = Math.max(margin, Math.min(y, window.innerHeight - mh - margin));
    menuEl.style.left = `${x}px`;
    menuEl.style.top = `${y}px`;
  }, []);

  // â”€â”€ Scroll preservation across page navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const HOME_SCROLL_KEY = 'planner-home-scroll-pos';
  const isUnmountingRef = useRef(false);
  const isRestoringScrollRef = useRef(false);

  useEffect(() => {
    return () => {
      isUnmountingRef.current = true;
    };
  }, []);

  /** `tab` deep-links straight to a section of the settings page. */
  const navigateToSettings = useCallback((tab?: string) => {
    if (mainRef.current) {
      try {
        sessionStorage.setItem(HOME_SCROLL_KEY, JSON.stringify({
          top: mainRef.current.scrollTop,
          left: mainRef.current.scrollLeft,
          windowY: window.scrollY || document.documentElement.scrollTop || 0,
        }));
      } catch (_) {}
    }
    setLocation(tab ? `/settings?tab=${encodeURIComponent(tab)}` : '/settings');
  }, [setLocation]);

  const handleMainScroll = useCallback(() => {
    repositionMenu();
    if (isUnmountingRef.current || isRestoringScrollRef.current) return;
    if (mainRef.current) {
      const top = mainRef.current.scrollTop;
      const left = mainRef.current.scrollLeft;
      const windowY = window.scrollY || document.documentElement.scrollTop || 0;

      // Ignore scroll events caused by DOM collapse during unmount/navigation
      if (top === 0 && mainRef.current.scrollHeight <= mainRef.current.clientHeight) {
        return;
      }

      try {
        sessionStorage.setItem(HOME_SCROLL_KEY, JSON.stringify({ top, left, windowY }));
      } catch (_) {}
    }
  }, [repositionMenu]);

  useLayoutEffect(() => {
    let t1: number, t2: number, t3: number;
    const restoreScroll = () => {
      try {
        const raw = sessionStorage.getItem(HOME_SCROLL_KEY);
        if (!raw) return;
        const pos = JSON.parse(raw);
        if (pos && typeof pos.top === 'number') {
          isRestoringScrollRef.current = true;
          if (mainRef.current) {
            mainRef.current.scrollTop = pos.top;
            if (typeof pos.left === 'number') mainRef.current.scrollLeft = pos.left;
          }
          if (typeof pos.windowY === 'number' && pos.windowY > 0) {
            window.scrollTo(0, pos.windowY);
          }
        }
      } catch (_) {}
    };

    restoreScroll();
    const rafId = requestAnimationFrame(restoreScroll);
    t1 = window.setTimeout(restoreScroll, 40);
    t2 = window.setTimeout(restoreScroll, 120);
    t3 = window.setTimeout(() => {
      restoreScroll();
      isRestoringScrollRef.current = false;
    }, 300);

    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, []);

  useLayoutEffect(() => {
    if (menuId === null) return;
    repositionMenu(); // correct the first paint before it's visible
    const onChange = () => repositionMenu();
    const mainEl = mainRef.current;
    mainEl?.addEventListener('scroll', onChange, { passive: true });
    window.addEventListener('scroll', onChange, { passive: true, capture: true });
    window.addEventListener('resize', onChange);
    // Re-clamp whenever the popup's own height changes (expanding "Custom" repeat,
    // toggling all-day, opening "Delete more…", etc.). Defer to the next frame so
    // writing the popup's position inside the observer can't re-trigger it in the
    // same tick — that's the "ResizeObserver loop completed" browser warning.
    let roFrame = 0;
    const ro = menuRef.current
      ? new ResizeObserver(() => {
          cancelAnimationFrame(roFrame);
          roFrame = requestAnimationFrame(onChange);
        })
      : null;
    if (ro && menuRef.current) ro.observe(menuRef.current);
    return () => {
      mainEl?.removeEventListener('scroll', onChange);
      window.removeEventListener('scroll', onChange, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onChange);
      cancelAnimationFrame(roFrame);
      ro?.disconnect();
    };
  }, [menuId, repositionMenu]);

  // Drag the popup around by its top handle. Pins it so auto-anchoring stops.
  const startMenuDrag = (e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const menuEl = menuRef.current;
    if (!menuEl) return;
    const r = menuEl.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    setMenuPinned(true);
    menuPinnedRef.current = true;
    const onMove = (ev: MouseEvent) => {
      const margin = 8;
      const mw = menuEl.offsetWidth, mh = menuEl.offsetHeight;
      let x = Math.max(margin, Math.min(ev.clientX - dx, window.innerWidth - mw - margin));
      let y = Math.max(margin, Math.min(ev.clientY - dy, window.innerHeight - mh - margin));
      menuEl.style.left = `${x}px`;
      menuEl.style.top = `${y}px`;
      menuPosRef.current = { x, y };
    };
    const onUp = () => {
      if (menuPosRef.current) setMenuPos(menuPosRef.current);
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  // Google Calendar Integration Functions & Hooks
  // Holds the exact events object returned by the last sync. The post-edit sync
  // effect compares against it by identity to recognise a "sync echo" and skip
  // re-syncing — otherwise applying a sync result would re-trigger a sync forever.
  const gcalEchoRef = useRef<PlannerData | null>(null);
  // Serialize syncs on the client: the server refuses concurrent runs, so a push that
  // lands mid-sync would otherwise be silently dropped until the 4-min pull. We run one
  // at a time and queue exactly one follow-up, guaranteeing the latest state is pushed.
  const syncInFlightRef = useRef(false);
  // -- Task mutations ---------------------------------------------------------
  // Deliberately NOT routed through writeEvents/undo: tasks are a separate store
  // with a separate Google backend, and mixing them into the event undo stack
  // would let Ctrl+Z on the calendar silently resurrect a deleted task. Declared
  // up here because the tasks sync driver below closes over it.
  const writeTasks = useCallback((next: TaskData) => {
    lastLocalTasksWriteRef.current = Date.now();
    tasksRef.current = next;
    setTasks(next);
  }, []);

  // One place to turn a sync response into something the user actually sees.
  // The same message is not repeated on every four-minute cycle — only when it
  // changes — or a broken connection would toast forever.
  const lastSyncProblemRef = useRef<string | null>(null);
  const reportSyncProblem = useCallback((label: string, res: { needsReconnect?: boolean; error?: string | null }) => {
    const problem = res?.needsReconnect
      ? `${label}: Google needs you to reconnect.`
      : res?.error
        ? `${label}: ${res.error}`
        : null;
    if (problem === lastSyncProblemRef.current) return;
    lastSyncProblemRef.current = problem;
    if (problem) showToast(problem, 'error');
  }, [showToast]);

  const syncQueuedRef = useRef(false);
  const triggerGCalSync = useCallback((customEvents?: PlannerData) => {
    // Never sync before events have loaded — see eventsLoadedRef.
    if (!customEvents && !eventsLoadedRef.current) return;
    if (syncInFlightRef.current) { syncQueuedRef.current = true; return; }
    syncInFlightRef.current = true;
    setGCalSyncing(true);
    // Snapshot of what we send. Anything the user edits while this round-trip is in
    // flight will differ from this by object identity, and must NOT be clobbered by
    // the (now stale) server response — that was the "title becomes Untitled" bug.
    const launched = customEvents || eventsRef.current;
    fetch('/api/google-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: launched, weekStartsOn, settings: loadSettingsLocal() })
    })
    .then(r => r.json())
    .then(res => {
      // Merge whenever the server returned a map. `success` false can mean "three
      // pushes failed" — the pulled half is still good and must not be thrown away.
      if (res.events) {
        const serverMap: PlannerData = res.events;
        const live = eventsRef.current;
        // Merge, don't replace: for records the user touched mid-flight (live differs
        // from the snapshot we sent), keep the live content and only adopt the Google
        // identity fields the server resolved. Untouched records take the server value.
        const merged: PlannerData = { ...serverMap };
        // Records we deleted while this (older) sync was in flight are gone from live
        // but still present in the stale serverMap. Without this, the server's copy
        // would resurrect them ~seconds later. Anything we *sent* (was in launched)
        // that no longer exists locally was deleted mid-flight â†’ drop it. Records the
        // server newly pulled (not in launched, e.g. foreign calendars) are kept.
        for (const id of Object.keys(serverMap)) {
          if (launched[id] !== undefined && live[id] === undefined) delete merged[id];
        }
        for (const [id, liveEv] of Object.entries(live)) {
          if (launched[id] === liveEv) continue; // untouched during flight
          const serverEv = serverMap[id];
          merged[id] = serverEv
            ? { ...liveEv, gCalId: serverEv.gCalId, gCalCalendarId: serverEv.gCalCalendarId, gCalETag: serverEv.gCalETag, gCalRecurSig: serverEv.gCalRecurSig, lastSyncedAt: serverEv.lastSyncedAt }
            : liveEv; // created during flight, server hasn't seen it yet
        }
        gcalEchoRef.current = merged; // mark this state change as a sync echo
        skipHistoryRef.current = true;    // and don't record it as an undo step
        eventsRef.current = merged;       // keep the ref hot (see writeEvents)
        setEvents(merged);
      }
      reportSyncProblem('Google Calendar', res);
    })
    .catch(err => {
      console.error('Google Calendar sync failed:', err);
      showToast('Google Calendar sync failed.', 'error');
    })
    .finally(() => {
      setGCalSyncing(false);
      syncInFlightRef.current = false;
      // Drain a queued follow-up so edits made mid-sync get pushed promptly.
      if (syncQueuedRef.current) { syncQueuedRef.current = false; triggerGCalSyncRef.current(); }
      fetch('/api/google-auth/status')
        .then(r => r.json())
        .then(status => {
          setGCalStatus(status);
          if (status.clientId) setClientIdInput(status.clientId);
        });
    });
  }, [weekStartsOn, showToast, reportSyncProblem]);

  // -- Google Tasks sync driver ------------------------------------------------
  // Same in-flight serialisation + mid-flight merge as the calendar sync above.
  // The merge matters more here than for events: Google Tasks has no
  // extendedProperties, so there is no plannerId to re-adopt an orphan by — if we
  // clobbered a gTaskId that the server just assigned, the next run would create
  // a duplicate task rather than recover.
  const tasksSyncInFlightRef = useRef(false);
  const tasksSyncQueuedRef = useRef(false);
  const triggerTasksSync = useCallback(() => {
    if (!tasksLoadedRef.current) return;
    if (tasksSyncInFlightRef.current) { tasksSyncQueuedRef.current = true; return; }
    tasksSyncInFlightRef.current = true;
    const launched = tasksRef.current;
    fetch('/api/google-tasks-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks: launched, today: todayYmd(), weekStartsOn }),
    })
      .then(r => r.json())
      .then(res => {
        if (!res.tasks) return;
        const serverMap: TaskData = res.tasks;
        const live = tasksRef.current;
        const merged: TaskData = { ...serverMap };
        // Anything we sent that no longer exists locally was deleted mid-flight —
        // the stale server copy must not resurrect it.
        for (const id of Object.keys(serverMap)) {
          if (launched[id] !== undefined && live[id] === undefined) delete merged[id];
        }
        for (const [id, liveTask] of Object.entries(live)) {
          if (launched[id] === liveTask) continue; // untouched during the flight
          const s = serverMap[id];
          merged[id] = s
            ? { ...liveTask, gTaskId: s.gTaskId, gTaskListId: s.gTaskListId, gTaskETag: s.gTaskETag, gTaskSeriesDate: s.gTaskSeriesDate, gTaskParentId: s.gTaskParentId, lastSyncedAt: s.lastSyncedAt }
            : liveTask; // created during the flight; the server hasn't seen it
        }
        if (JSON.stringify(merged) !== JSON.stringify(live)) writeTasks(merged);
        reportSyncProblem('Google Tasks', res);
      })
      .catch(err => console.error('Google Tasks sync failed:', err))
      .finally(() => {
        tasksSyncInFlightRef.current = false;
        if (tasksSyncQueuedRef.current) { tasksSyncQueuedRef.current = false; triggerTasksSyncRef.current(); }
      });
  }, [weekStartsOn, writeTasks, reportSyncProblem]);
  const triggerTasksSyncRef = useRef(triggerTasksSync);
  useEffect(() => { triggerTasksSyncRef.current = triggerTasksSync; }, [triggerTasksSync]);

  useEffect(() => {
    return subscribeSettingsChange(s => {
      // Adopt the WHOLE snapshot. Adopting a subset was silently destructive:
      // this page re-broadcasts everything it holds, so any field it failed to
      // adopt was immediately pushed back over the change that had just been
      // made (calendarView, the custom-view day counts and the task checkbox
      // shape all reverted this way).
      applySettingsSnapshotRef.current(s);
    });
  }, []);

  // Stable ref so the queue-drain above can call the latest triggerGCalSync.
  const triggerGCalSyncRef = useRef(triggerGCalSync);
  useEffect(() => { triggerGCalSyncRef.current = triggerGCalSync; }, [triggerGCalSync]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    // Google can also come back with ?error=access_denied (or similar) instead of
    // a code. That used to be dropped on the floor, leaving the user staring at a
    // planner that silently hadn't connected.
    const authError = urlParams.get('error');
    if (authError) {
      window.history.replaceState({}, document.title, window.location.pathname);
      showToast(
        authError === 'access_denied'
          ? 'Google sign-in was cancelled — not connected.'
          : `Google sign-in failed: ${authError}`,
        'error',
      );
    }

    const code = urlParams.get('code');
    if (code) {
      const state = urlParams.get('state');
      window.history.replaceState({}, document.title, window.location.pathname);
      // Must be byte-identical to the redirect_uri used in the auth request, or
      // Google rejects the exchange too.
      const redirectUri = window.location.origin;
      fetch('/api/google-auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri, state })
      })
      .then(r => r.json())
      .then(res => {
        if (res.success) {
          showToast('Google connected.', 'success');
          fetch('/api/google-auth/status').then(r => r.json()).then(setGCalStatus).catch(() => {});
          triggerGCalSync();
        } else {
          console.error('Failed to exchange auth code:', res.error, res.detail || '');
          showToast(res.error || 'Could not complete the Google connection.', 'error');
        }
      })
      .catch(err => console.error('Error during token exchange:', err));
    }
  }, [triggerGCalSync, showToast]);

  useEffect(() => {
    if (!gCalStatus.authenticated || !gCalStatus.autoSync) return;
    const intervalId = setInterval(() => {
      triggerGCalSync();
    }, 4 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [gCalStatus.authenticated, gCalStatus.autoSync, triggerGCalSync]);

  // Poll the connection's health even when nothing is syncing. Without this the
  // status only ever refreshed as a side effect of a sync — so once the token
  // died and the sync loops stopped, the UI kept showing the last good state
  // until the page was reloaded.
  useEffect(() => {
    const pull = () => {
      fetch('/api/google-auth/status')
        .then(r => r.json())
        .then(status => { if (status && typeof status === 'object') setGCalStatus(status); })
        .catch(() => {});
    };
    const id = setInterval(pull, 60000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (isInitialMount.current || !gCalStatus.authenticated) return;
    // Never push mid-edit: while an item is focused for editing (e.g. typing a
    // title) we hold off. The push fires once editing finishes (editingId â†’ null,
    // i.e. focus leaves the item) or after a structural change settles.
    if (editingId !== null) return;
    // If this render is the result of applying a sync response, don't sync again.
    if (gcalEchoRef.current === events) { gcalEchoRef.current = null; return; }
    const timer = setTimeout(() => { triggerGCalSync(); }, 800);
    return () => clearTimeout(timer);
  }, [events, editingId, gCalStatus.authenticated, triggerGCalSync]);

  // Tasks: the same pair of triggers. Gated additionally on the Tasks scope
  // actually having been granted — an old calendar-only token would 403 on
  // every call. The server bails silently too; this just avoids the round-trip.
  const tasksSyncReady = gCalStatus.authenticated && !!gCalStatus.hasTasksScope && googleTasksSync;
  useEffect(() => {
    if (!tasksSyncReady || !gCalStatus.autoSync) return;
    triggerTasksSync();
    const intervalId = setInterval(() => triggerTasksSync(), 4 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [tasksSyncReady, gCalStatus.autoSync, triggerTasksSync]);

  useEffect(() => {
    if (isInitialMount.current || !tasksSyncReady) return;
    if (taskMenuId !== null) return; // don't push mid-edit
    const timer = setTimeout(() => { triggerTasksSync(); }, 1200);
    return () => clearTimeout(timer);
  }, [tasks, taskMenuId, tasksSyncReady, triggerTasksSync]);


  // â”€â”€ Derived â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const weekStart   = startOfWeek(currentDate, { weekStartsOn });
  const days        = eachDayOfInterval({ start: weekStart, end: endOfWeek(currentDate, { weekStartsOn }) });
  // Day view reuses the whole week grid but paints a single column. Events keep
  // their 0–6 week-relative dayIndex, so everything below works off this mapping
  // between a *visible slot* and the real day index it stands for.
  const dayViewColIdx = (currentDate.getDay() - weekStartsOn + 7) % 7;
  // Custom view widens the grid past the anchor week: column offsets run from
  // -P (P days before the week start) through N-1. Offsets outside 0–6 address
  // days in the neighbouring weeks and are perfectly legal here — only STORED
  // records must stay in range (see normalizeAnchor).
  const customFrom = -clamp(customDaysBefore, 0, CUSTOM_BEFORE_MAX);
  const customTo   = clamp(customDaysAfter, CUSTOM_AFTER_MIN, CUSTOM_AFTER_MAX);
  const visibleCols   = calendarView === 'day'
    ? [dayViewColIdx]
    : calendarView === 'custom'
      ? Array.from({ length: customTo - customFrom }, (_, i) => customFrom + i)
      : [0, 1, 2, 3, 4, 5, 6];
  const colCount      = visibleCols.length;
  // Which week of its month the viewed week is — counted by week starts, so the
  // week containing the 1st is week 1 even when it begins in the previous month.
  const weekOfMonth = differenceInCalendarWeeks(weekStart, startOfMonth(weekStart), { weekStartsOn }) + 1;
  /** The date a column offset stands for (offsets may fall outside the week). */
  const dayAt = useCallback((offset: number) => addDays(weekStart, offset), [weekStart]);
  /** Visible slot for a week dayIndex, or -1 when that day isn't on screen. */
  const colSlot = (dayIndex: number) => visibleCols.indexOf(dayIndex);
  // Grids that render the timeline use these so day view stretches to full width.
  const isDayView = calendarView === 'day';
  const isCustomView = calendarView === 'custom';
  // The window of day offsets the grid resolves events over.
  const viewRange = useMemo(
    () => (isCustomView ? { from: customFrom, to: customTo } : { from: 0, to: 7 }),
    [isCustomView, customFrom, customTo],
  );
  // 'day', 'week' and 'custom' all render the timeline grid.
  const isTimelineView = calendarView === 'day' || calendarView === 'week' || calendarView === 'custom';
  // Long-lived mouse handlers read the visible columns through a ref.
  const visibleColsRef = useRef<number[]>(visibleCols);
  visibleColsRef.current = visibleCols;
  const slots       = generateSlots(interval, dayStartH, dayEndH);
  const sh          = SLOT_H[interval];
  const totalH      = slots.length * sh;
  const dayEndMin   = dayEndH * 60;
  const dayStartMin = dayStartH * 60;
  const darkPalette = (eventColorStyle as string) === 'classic' ? CLASSIC_DARK_EVENT_COLORS : VIVID_DARK_EVENT_COLORS;
  const colorPalette = darkMode ? darkPalette : EVENT_COLORS;
  // Universal event card styles (tinted, solid, minimal, glowing) for ALL planner items & Google Calendar.
  const pageBg = themePalette(darkMode, darkPreset, lightPreset).rootBg;
  const chipColors = useCallback((ev: PlannerEvent) =>
    gcalChipColors(resolveEventHex(ev), { dark: darkMode, style: eventColorStyle as EventCardStyle, pageBg })
      ?? { bg: '#dcfce7', border: '#86efac', text: '#14532d', textMuted: '#2f6b45' },
    [darkMode, eventColorStyle, pageBg]);
  // Tasks always paint in the one colour from settings, never a per-item swatch —
  // that uniformity is what makes a task read as a task on the grid.
  const taskChipColors = useCallback((hex?: string) =>
    gcalChipColors(hex || taskColor, { dark: darkMode, style: eventColorStyle as EventCardStyle, pageBg })
      ?? { bg: '#e0f2fe', border: '#7dd3fc', text: '#0c4a6e', textMuted: '#0369a1' },
    [darkMode, eventColorStyle, pageBg, taskColor]);

  // â”€â”€ Modification domain / week resolution â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const viewedWeekKey     = weekKeyOf(currentDate, weekStartsOn);
  const currentRealWeekKey = weekKeyOf(new Date(nowTick), weekStartsOn);
  const isPastWeek        = viewedWeekKey < currentRealWeekKey;
  // Items visible in the viewed week, keyed by the storage id actually shown.
  const weekEvents = useMemo(() => resolveWeek(events, viewedWeekKey, viewRange), [events, viewedWeekKey, viewRange]);
  const weekAllDayEvents = useMemo(() => {
    const rawAllDays = Object.values(weekEvents).filter(ev => ev.allDay && !ev.deleted);
    const mapped: Array<PlannerEvent & { visibleDayIndex: number; visibleDaysSpan: number }> = [];
    for (const ev of rawAllDays) {
      const overlap = getEventWeekOverlap(ev, weekStart, viewRange);
      if (overlap) {
        mapped.push({
          ...ev,
          visibleDayIndex: overlap.dayIndex,
          visibleDaysSpan: overlap.daysSpan
        });
      }
    }
    return mapped;
  }, [weekEvents, weekStart, viewRange]);
  const allDayLayout = useMemo(() => {
    return layoutAllDay(weekAllDayEvents);
  }, [weekAllDayEvents]);
  const maxAllDayRowIndex = useMemo(() => {
    let maxR = -1;
    for (const info of allDayLayout.values()) {
      if (info.row > maxR) maxR = info.row;
    }
    return maxR + 1;
  }, [allDayLayout]);
  const allDayHeight = maxAllDayRowIndex > 0 ? (maxAllDayRowIndex * 28 + 8) : 36;

  // â”€â”€ Task bands â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tasks visible in the viewed week, split by kind. Unlike all-day events a task
  // never spans days, so the dated band needs no packing layout — each chip sits
  // in its own day column.
  const weekTasks = useMemo(() => resolveWeekTasks(tasks, viewedWeekKey, viewRange), [tasks, viewedWeekKey, viewRange]);
  // Keyed by column OFFSET rather than a fixed 0-6 array, so the custom view's
  // out-of-week columns get their tasks too.
  const bucketTasks = useCallback((timed: boolean) => {
    const cols = new Map<number, Task[]>();
    for (const t of Object.values(weekTasks)) {
      if (t.deleted || (timed ? !t.startTime : !!t.startTime)) continue;
      const i = t.dayIndex ?? 0;
      if (i < viewRange.from || i >= viewRange.to) continue;
      const bucket = cols.get(i);
      if (bucket) bucket.push(t); else cols.set(i, [t]);
    }
    return cols;
  }, [weekTasks, viewRange]);
  const dayAtRef = useRef(dayAt);
  useEffect(() => { dayAtRef.current = dayAt; }, [dayAt]);

  const datedTasksByCol = useMemo(() => {
    const cols = bucketTasks(false);
    for (const c of cols.values()) c.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.title.localeCompare(b.title));
    return cols;
  }, [bucketTasks]);
  const timedTasksByCol = useMemo(() => bucketTasks(true), [bucketTasks]);
  const datedTasksByColRef = useRef(datedTasksByCol);
  useEffect(() => { datedTasksByColRef.current = datedTasksByCol; }, [datedTasksByCol]);
  const weekTasksRef = useRef(weekTasks);
  useEffect(() => { weekTasksRef.current = weekTasks; }, [weekTasks]);
  const maxTasksInAnyCol = useMemo(
    () => [...datedTasksByCol.values()].reduce((m, c) => Math.max(m, c.length), 0),
    [datedTasksByCol],
  );
  // The band is only drawn in week/day view — month and year lay themselves out.
  const showTaskBand = showTaskRow && isTimelineView;
  const taskRowHeight = showTaskBand
    ? Math.max(TASK_ROW_MIN_H, maxTasksInAnyCol * (TASK_CHIP_H + 2) + 8)
    : 0;

  // â”€â”€ Prayer times â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Drawn from the API-backed cache, never from the events store: a prayer has a
  // start time and no duration, so it is a marker on the grid, not a block.
  const visibleColsSig = visibleCols.join(',');
  const prayerDates = useMemo(() => {
    const days = visibleCols.map(c => dayAt(c));
    // A column for day D runs D dayStart â†’ D+1 dayStart, so the day AFTER the last
    // column can still contribute its pre-dawn prayers and has to be loaded too.
    if (days.length) days.push(addDays(days[days.length - 1], 1));
    return days;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleColsSig, dayAt]);
  const { prayersFor, rawTimesFor, isDone: isPrayerDone, toggleDone: togglePrayerDone } = usePrayerTimes(prayer, prayerDates);
  // Today's complete list for the header panel: Sunrise and any individually
  // hidden prayers included, because that panel exists to show the whole day.
  const todayPrayerList = useMemo(() => {
    if (!prayer.enabled) return [] as PrayerOccurrence[];
    const today = new Date(nowTick);
    return buildPrayerDay(prayerDateKey(today), rawTimesFor(today), { ...prayer, showSunrise: true, hidden: [] });
    // nowTick only matters here for the date rolling over, so round it to the day.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prayer, rawTimesFor, prayerDateKey(new Date(nowTick))]);
  // Close the prayer panel on an outside click or Escape, like every other popup.
  useEffect(() => {
    if (!prayerPanelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!prayerPanelRef.current?.contains(e.target as Node)) setPrayerPanelOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPrayerPanelOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [prayerPanelOpen]);

  /** The next prayer still to come today — what the header button advertises. */
  const nextPrayer = useMemo(() => {
    const now = new Date(nowTick);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    return todayPrayerList.find(p => p.minutes >= nowMinutes) ?? null;
  }, [todayPrayerList, nowTick]);
  /**
   * The prayers that land inside one visible day column, with the grid minute to
   * draw them at. Mirrors the now-line's day-boundary rule: before the day-start
   * hour belongs to the PREVIOUS calendar day's column.
   */
  const columnPrayers = useCallback((day: Date): Array<PrayerOccurrence & { norm: number }> => {
    if (!prayer.enabled) return [];
    const out: Array<PrayerOccurrence & { norm: number }> = [];
    for (const p of prayersFor(day)) {
      if (p.minutes < dayStartMin) continue;       // the previous column owns it
      out.push({ ...p, norm: p.minutes });
    }
    for (const p of prayersFor(addDays(day, 1))) {
      if (p.minutes >= dayStartMin) continue;      // that day owns it itself
      out.push({ ...p, norm: p.minutes + 1440 });
    }
    return out.sort((a, b) => a.norm - b.norm);
  }, [prayer.enabled, prayersFor, dayStartMin]);

  // The prayer band ("Its own row" style) — every prayer of the calendar day,
  // including the ones outside the visible hour window.
  const showPrayerBand = prayer.enabled && prayer.style === 'row' && isTimelineView;
  const maxPrayersInAnyCol = useMemo(() => {
    if (!showPrayerBand) return 0;
    return visibleCols.reduce((m, c) => Math.max(m, prayersFor(dayAt(c)).length), 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPrayerBand, visibleColsSig, dayAt, prayersFor]);
  const prayerRowHeight = showPrayerBand
    ? Math.max(PRAYER_ROW_MIN_H, maxPrayersInAnyCol * (PRAYER_CHIP_H + 2) + 8)
    : 0;

  /**
   * Total height of every fixed band above the scrollable time grid: the day
   * header, the All Day row, the task row and the prayer row.
   *
   * EVERY mouse-Y â†’ minute conversion and every absolutely-positioned overlay
   * inside `daysGridRef` MUST use this instead of adding the pieces up itself —
   * that is what keeps a new band from silently breaking drag, resize, marquee
   * select and click-to-create. There must be no `HEADER_PX + allDayHeight`
   * anywhere else in this file.
   */
  const topBandsHeight = HEADER_PX + allDayHeight + taskRowHeight + prayerRowHeight;

  // Month overview: full weeks covering the current month, each day resolved to the
  // events actually visible that week (recurring versions + single-week overrides).
  const monthMatrix = useMemo(() => {
    if (calendarView !== 'month') return [] as Array<{ weekKey: string; cells: Array<{ date: Date; events: PlannerEvent[] }> }>;
    const gridStart = startOfWeek(startOfMonth(currentDate), { weekStartsOn });
    const gridEnd   = endOfWeek(endOfMonth(currentDate), { weekStartsOn });
    const allDays   = eachDayOfInterval({ start: gridStart, end: gridEnd });
    const weeks: Array<{ weekKey: string; cells: Array<{ date: Date; events: PlannerEvent[] }> }> = [];
    for (let i = 0; i < allDays.length; i += 7) {
      const chunk = allDays.slice(i, i + 7);
      const wkey = weekKeyOf(chunk[0], weekStartsOn);
      const resolved = resolveWeek(events, wkey);
      const weekStartDate = parseDate(wkey);
      const cells = chunk.map((date, col) => ({
        date,
        events: Object.values(resolved)
          .filter(e => {
            if (e.allDay) {
              const overlap = getEventWeekOverlap(e, weekStartDate);
              return overlap && col >= overlap.dayIndex && col < overlap.dayIndex + overlap.daysSpan;
            }
            return e.dayIndex === col;
          })
          .sort((a, b) => timeToMin(a.startTime) - timeToMin(b.startTime)),
      }));
      weeks.push({ weekKey: wkey, cells });
    }
    return weeks;
  }, [calendarView, currentDate, weekStartsOn, events]);

  // Year overview: 12 mini months. Resolving every week of the year is the
  // expensive bit, so each week is resolved once and shared across its days.
  const yearMatrix = useMemo(() => {
    if (calendarView !== 'year') {
      return [] as Array<{ monthStart: Date; isCurrent: boolean; eventCount: number; cells: Array<{ date: Date; count: number }> }>;
    }
    const weekCache = new Map<string, PlannerData>();
    const resolveCached = (wkey: string) => {
      let r = weekCache.get(wkey);
      if (!r) { r = resolveWeek(events, wkey); weekCache.set(wkey, r); }
      return r;
    };
    return Array.from({ length: 12 }, (_, m) => {
      const monthStart = new Date(currentDate.getFullYear(), m, 1);
      const gridStart = startOfWeek(startOfMonth(monthStart), { weekStartsOn });
      const gridEnd   = endOfWeek(endOfMonth(monthStart), { weekStartsOn });
      let eventCount = 0;
      const cells = eachDayOfInterval({ start: gridStart, end: gridEnd }).map(date => {
        const wkey = weekKeyOf(date, weekStartsOn);
        const col = (date.getDay() - weekStartsOn + 7) % 7;
        const count = Object.values(resolveCached(wkey)).filter(e => {
          if (e.allDay) {
            const overlap = getEventWeekOverlap(e, parseDate(wkey));
            return overlap && col >= overlap.dayIndex && col < overlap.dayIndex + overlap.daysSpan;
          }
          return e.dayIndex === col;
        }).length;
        if (isSameMonth(date, monthStart)) eventCount += count;
        return { date, count };
      });
      return { monthStart, isCurrent: isSameMonth(monthStart, new Date()), eventCount, cells };
    });
  }, [calendarView, currentDate, weekStartsOn, events]);

  const weekEventsRef = useRef<PlannerData>({});
  useEffect(() => { weekEventsRef.current = weekEvents; }, [weekEvents]);
  // The viewed week + week-start are all the resolver needs. Refs keep the latest
  // values available inside the long-lived mouse/keyboard handlers.
  const editCtxRef = useRef({ viewedWeekKey, weekStartsOn });
  useEffect(() => { editCtxRef.current = { viewedWeekKey, weekStartsOn }; }, [viewedWeekKey, weekStartsOn]);

  // Commit a new events map AND update eventsRef synchronously. eventsRef is normally
  // refreshed by an effect (one render later); during a fast multi-hop drag the next
  // mutation can fire before that effect runs, so it would build on a STALE map — the
  // previous move gets re-applied against old state and a repeating occurrence detaches
  // twice, leaving a duplicate "ghost" at each temporary spot. Writing the ref here
  // keeps back-to-back mutations chained on the latest result.
  const writeEvents = useCallback((next: PlannerData) => {
    lastLocalEventsWriteRef.current = Date.now();
    eventsRef.current = next;
    setEvents(next);
  }, []);

  /**
   * Apply a full settings snapshot to this page's state.
   *
   * ONE place, used by every loader (localStorage on boot, the file DB, and the
   * re-sync when returning from the settings page). The loaders used to each
   * carry their own hand-written list of fields, and a field missing from a list
   * was not merely "not loaded": this page still BROADCASTS every field it holds,
   * so an unread field was overwritten on the server with whatever stale value
   * this page happened to be holding. `widgetDarkPreset` was missing from the
   * file-DB loader, which is exactly why the side window's colour reset itself
   * every time the app reloaded.
   *
   * The exhaustiveness map below makes that class of bug a compile error rather
   * than a mystery: adding a field to AppSettings fails the typecheck until it is
   * listed here, and listing it without wiring it up is immediately visible.
   */
  const applySettingsSnapshot = useCallback((s: AppSettings) => {
    const handled: Record<keyof AppSettings, true> = {
      interval: true, darkMode: true, darkPreset: true, lightPreset: true,
      widgetDarkPreset: true, widgetLightPreset: true, eventColorStyle: true,
      sidebarStyle: true, timeFormat: true, weekStartsOn: true, dayStartH: true,
      dayEndH: true, calendarView: true, customDaysBefore: true, customDaysAfter: true,
      focusDayStartHour: true, focusChime: true, focusCues: true, shortcuts: true,
      autoBackup: true, tasksPanelOpen: true, tasksPanelWidth: true, showTaskRow: true,
      taskColor: true, taskCheckboxShape: true, taskFilters: true, googleTasksSync: true,
      prayer: true,
    };
    void handled;

    setIntervalOpt(s.interval);
    setDarkMode(s.darkMode);
    setDarkPreset(s.darkPreset);
    setLightPreset(s.lightPreset);
    setWidgetDarkPreset(s.widgetDarkPreset);
    setWidgetLightPreset(s.widgetLightPreset);
    setEventColorStyle(s.eventColorStyle);
    setSidebarStyle(s.sidebarStyle);
    setTimeFormat(s.timeFormat);
    setWeekStartsOn(s.weekStartsOn);
    setDayStartH(s.dayStartH);
    setDayEndH(s.dayEndH);
    if (isCalendarView(s.calendarView)) setCalendarView(s.calendarView);
    setCustomDaysBefore(clamp(s.customDaysBefore, 0, CUSTOM_BEFORE_MAX));
    setCustomDaysAfter(clamp(s.customDaysAfter, CUSTOM_AFTER_MIN, CUSTOM_AFTER_MAX));
    setFocusDayStartHour(s.focusDayStartHour);
    setFocusChime(s.focusChime);
    setFocusCues(s.focusCues);
    setShortcuts(s.shortcuts);
    setAutoBackup(s.autoBackup);
    setTasksPanelOpen(s.tasksPanelOpen);
    setTasksPanelWidth(clampPanelWidth(s.tasksPanelWidth));
    setShowTaskRow(s.showTaskRow);
    setTaskColor(s.taskColor);
    setTaskCheckboxShape(s.taskCheckboxShape);
    setTaskFilters(canonicalFilters(s.taskFilters));
    setGoogleTasksSync(s.googleTasksSync);
    setPrayer(s.prayer);
  }, []);
  const applySettingsSnapshotRef = useRef(applySettingsSnapshot);
  useEffect(() => { applySettingsSnapshotRef.current = applySettingsSnapshot; }, [applySettingsSnapshot]);

  // Patch the occurrence shown as `id`, routed to its stored master (an edit is to
  // the whole item). Remaps UI references if the occurrence id shifted (e.g. a
  // day-move). Returns the new occurrence id.
  const applyEdit = useCallback((id: string, patch: Partial<PlannerEvent>): string => {
    // Draft (dedicated-create) edits stay in local draft state — not committed.
    if (draftRef.current && id === draftRef.current.id) {
      setDraft(d => (d ? { ...d, ...patch } : d));
      return id;
    }
    const { viewedWeekKey, weekStartsOn } = editCtxRef.current;
    const { events: map, targetId } = editSeries(eventsRef.current, id, patch, viewedWeekKey, weekStartsOn);
    writeEvents(map);
    if (targetId !== id) {
      setEditingId(e => (e === id ? targetId : e));
      setMenuId(m => (m === id ? targetId : m));
      setSelectedIds(prev => {
        if (!prev.has(id)) return prev;
        const n = new Set(prev); n.delete(id); n.add(targetId); return n;
      });
    }
    return targetId;
  }, [writeEvents]);
  const applyEditRef = useRef(applyEdit);
  useEffect(() => { applyEditRef.current = applyEdit; }, [applyEdit]);

  // Patch several visible occurrences at once (batch drag).
  const applyEditMany = useCallback((patches: Record<string, Partial<PlannerEvent>>) => {
    const { viewedWeekKey, weekStartsOn } = editCtxRef.current;
    let map = eventsRef.current;
    const remap: Record<string, string> = {};
    for (const [id, patch] of Object.entries(patches)) {
      const res = editSeries(map, id, patch, viewedWeekKey, weekStartsOn);
      map = res.events;
      if (res.targetId !== id) remap[id] = res.targetId;
    }
    writeEvents(map);
    if (Object.keys(remap).length) {
      setSelectedIds(prev => {
        const n = new Set<string>();
        for (const id of prev) n.add(remap[id] ?? id);
        return n;
      });
    }
  }, [writeEvents]);

  // ── Linked items ────────────────────────────────────────────────────────────
  // A link group is a plain shared id. Membership is resolved against what is
  // VISIBLE in the current view, because that is what can actually be dragged:
  // a partner outside the viewed range has nothing on screen to move.

  /** Occurrence ids currently on screen that share `ev`'s link group (incl. itself). */
  const linkedIdsOf = useCallback((ev: PlannerEvent | undefined, id: string): string[] => {
    if (!ev?.linkGroup) return [id];
    const out: string[] = [];
    for (const [otherId, other] of Object.entries(weekEventsRef.current)) {
      if (other.deleted || other.allDay) continue;
      if (other.linkGroup === ev.linkGroup) out.push(otherId);
    }
    return out.length ? out : [id];
  }, []);

  /**
   * The item immediately above/below this one in the same day column — the
   * carriage to couple to. "Nearest" is by start time; ties and overlaps are
   * fine, we just take the closest one that isn't already in the group.
   */
  const linkNeighbour = useCallback((id: string, dir: 'prev' | 'next'): { id: string; ev: PlannerEvent } | null => {
    const ev = weekEventsRef.current[id] ?? eventsRef.current[id];
    if (!ev) return null;
    const start = normalizeMin(timeToMin(ev.startTime), dayStartH);
    let best: { id: string; ev: PlannerEvent; delta: number } | null = null;
    for (const [otherId, other] of Object.entries(weekEventsRef.current)) {
      if (otherId === id || other.deleted || other.allDay) continue;
      if (other.dayIndex !== ev.dayIndex) continue;
      if (ev.linkGroup && other.linkGroup === ev.linkGroup) continue; // already coupled
      const otherStart = normalizeMin(timeToMin(other.startTime), dayStartH);
      const delta = dir === 'prev' ? start - otherStart : otherStart - start;
      if (delta <= 0) continue; // wrong side (or exactly level — ambiguous, skip)
      if (!best || delta < best.delta) best = { id: otherId, ev: other, delta };
    }
    return best ? { id: best.id, ev: best.ev } : null;
  }, [dayStartH]);

  /** Couple `id` to its neighbour, merging whatever groups either already had. */
  const linkToNeighbour = useCallback((id: string, dir: 'prev' | 'next') => {
    const ev = weekEventsRef.current[id] ?? eventsRef.current[id];
    const neighbour = linkNeighbour(id, dir);
    if (!ev || !neighbour) {
      showToast(`No item ${dir === 'prev' ? 'above' : 'below'} this one to link to.`, 'error');
      return;
    }
    // Keep an existing group id where there is one, so coupling a third carriage
    // to a train doesn't renumber the whole train.
    const groupId = ev.linkGroup || neighbour.ev.linkGroup || uid();
    const affected = new Set<string>([id, neighbour.id]);
    for (const gid of linkedIdsOf(ev, id)) affected.add(gid);
    for (const gid of linkedIdsOf(neighbour.ev, neighbour.id)) affected.add(gid);

    const patches: Record<string, Partial<PlannerEvent>> = {};
    for (const aid of affected) {
      const target = weekEventsRef.current[aid] ?? eventsRef.current[aid];
      if (target && target.linkGroup !== groupId) patches[aid] = { linkGroup: groupId };
    }
    if (Object.keys(patches).length) applyEditMany(patches);
    showToast(`Linked to “${neighbour.ev.content || 'Untitled'}”.`, 'success');
  }, [linkNeighbour, linkedIdsOf, applyEditMany, showToast]);

  /** Uncouple one item; the rest of the train stays coupled. */
  const unlinkItem = useCallback((id: string) => {
    applyEdit(id, { linkGroup: undefined });
    showToast('Unlinked.', 'info');
  }, [applyEdit, showToast]);

  const applyEditManyRef = useRef(applyEditMany);
  useEffect(() => { applyEditManyRef.current = applyEditMany; }, [applyEditMany]);

  // Delete the occurrence shown as `id`. `mode` scopes a repeating item's delete
  // ('one' = just this occurrence; 'following'; 'all'). Non-repeating ignores it.
  const applyDelete = useCallback((id: string, mode: DeleteMode = 'one') => {
    writeEvents(deleteScoped(eventsRef.current, id, mode));
  }, [writeEvents]);
  const applyDeleteRef = useRef(applyDelete);
  useEffect(() => { applyDeleteRef.current = applyDelete; }, [applyDelete]);

  // Delete several visible occurrences at once (keyboard delete = 'one' each).
  const applyDeleteMany = useCallback((ids: Iterable<string>) => {
    let map = eventsRef.current;
    for (const id of ids) map = deleteScoped(map, id, 'one');
    writeEvents(map);
  }, [writeEvents]);
  const applyDeleteManyRef = useRef(applyDeleteMany);
  useEffect(() => { applyDeleteManyRef.current = applyDeleteMany; }, [applyDeleteMany]);

  // Create a brand-new item, anchored to the viewed week (recurrence optional).
  const createStamped = useCallback((base: PlannerEvent, opts?: { edit?: boolean; menuAt?: { x: number; y: number } }) => {
    const stamped = stampNewItem(base, editCtxRef.current.viewedWeekKey, editCtxRef.current.weekStartsOn);
    writeEvents({ ...eventsRef.current, [stamped.id]: stamped });
    if (opts?.edit) setEditingId(stamped.id);
    if (opts?.menuAt) { setMenuPinned(false); setMenuId(stamped.id); setMenuPos(opts.menuAt); }
    return stamped.id;
  }, [writeEvents]);
  const createStampedRef = useRef(createStamped);
  useEffect(() => { createStampedRef.current = createStamped; }, [createStamped]);

  /**
   * Create a task. The default — enforced here rather than at each call site —
   * is today's date with no time. Passing `dueDate: null` makes it general
   * (panel only); a `startTime` makes it a timed task drawn in the day column.
   */
  const createTask = useCallback((input: NewTaskInput & Partial<Task>) => {
    const title = (input.title ?? '').trim();
    if (!title) return null;
    const wso = editCtxRef.current.weekStartsOn;
    const { dueDate, startTime, ...rest } = input;
    let t = makeTask({ ...rest, title }, wso);
    if (dueDate !== undefined) t = withDueDate(t, dueDate, wso);
    if (startTime) t = withTime(t, startTime);
    writeTasks({ ...tasksRef.current, [t.id]: t });
    return t.id;
  }, [writeTasks]);

  const editTask = useCallback((occId: string, patch: Partial<Task>) => {
    const { viewedWeekKey, weekStartsOn } = editCtxRef.current;
    const { events: map, targetId } = editTaskSeries(tasksRef.current, occId, patch, viewedWeekKey, weekStartsOn);
    writeTasks(map);
    return targetId;
  }, [writeTasks]);

  // ── Dragging task chips in the band ────────────────────────────────────────
  // Native HTML5 drag rather than the mouse-tracking rig the events use: chips
  // live in a normal flow row, so the browser's own drag gives us the ordering
  // and cross-column drop for free, and it can't interfere with event dragging.
  const [taskDragId, setTaskDragId] = useState<string | null>(null);
  const [taskDropCol, setTaskDropCol] = useState<number | null>(null);

  /**
   * Drop a task into a day column at a given position.
   *
   * `beforeId` is the chip it was dropped above (null = dropped at the end).
   * The column is then renumbered 0..n so "first in the list" survives a reload
   * — order is a stored field, not a rendering accident.
   */
  const moveTaskToColumn = useCallback((occId: string, colIdx: number, beforeId: string | null) => {
    const wso = editCtxRef.current.weekStartsOn;
    const target = weekTasksRef.current[occId] ?? tasksRef.current[occId];
    if (!target) return;
    const ymd = format(dayAtRef.current(colIdx), 'yyyy-MM-dd');

    // Everything already sitting in that column, in display order, with the
    // dragged chip removed and re-inserted at the drop point.
    const column = (datedTasksByColRef.current.get(colIdx) ?? []).filter(t => t.id !== occId);
    const insertAt = beforeId ? column.findIndex(t => t.id === beforeId) : -1;
    const ordered = [...column];
    ordered.splice(insertAt === -1 ? ordered.length : insertAt, 0, { ...target, id: occId } as Task);

    let map = tasksRef.current;
    ordered.forEach((t, i) => {
      const isDragged = t.id === occId;
      const current = map[t.id] ?? weekTasksRef.current[t.id];
      if (!current) return;
      // Only the dragged chip changes day; the rest just get their new index.
      // Clear startTime & endTime so dropping onto the top task band turns timed tasks into top-of-day tasks.
      const patch: Partial<Task> = isDragged
        ? { ...withDueDate(current, ymd, wso), startTime: undefined, endTime: undefined, order: i }
        : { order: i };
      const res = editTaskSeries(map, t.id, patch, editCtxRef.current.viewedWeekKey, wso);
      map = res.events;
    });
    writeTasks(map);
  }, [writeTasks]);

  const deleteTask = useCallback((occId: string, mode: DeleteMode = 'one') => {
    writeTasks(deleteTaskScoped(tasksRef.current, occId, mode));
    setTaskMenuId(m => (m === occId ? null : m));
  }, [writeTasks]);

  const handleToggleTaskDone = useCallback((occId: string) => {
    writeTasks(toggleTaskDone(tasksRef.current, occId));
  }, [writeTasks]);

  const openTaskMenu = useCallback((occId: string, at: { x: number; y: number }) => {
    setTaskMenuId(occId);
    setTaskMenuPos(at);
    setMenuId(null); // never two popovers at once
  }, []);

  // Entering edit mode on an existing item materialises the concrete record edits
  // should land on *up front* (so the text box never remounts mid-typing). If the
  // user then makes no real change, `finishEdit` drops the freshly-forked record
  // Editing routes directly to the master (an edit is to the whole item), so
  // entering/leaving edit mode is just toggling the focused occurrence id. The
  // Google push fires from the post-edit effect once editingId returns to null.
  const enterEdit = useCallback((id: string) => {
    setEditingId(id);
  }, []);

  const finishEdit = useCallback(() => {
    setEditingId(null);
  }, []);

  // â”€â”€ Live time indicator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const nowDate = useMemo(() => new Date(nowTick), [nowTick]);
  const nowMin  = nowDate.getHours() * 60 + nowDate.getMinutes();
  const normNowMin = normalizeMin(nowMin, dayStartH);
  const nowInView = normNowMin >= dayStartMin && normNowMin <= dayEndMin;
  // A day column spans dayStartH â†’ dayStartH+24 (e.g. 7am â†’ 7am). So between
  // midnight and the day-start hour, "now" belongs to the PREVIOUS calendar day's
  // column, not today's — otherwise the red line lands a whole day too far right.
  const nowOwnerDate = nowMin < dayStartMin ? subDays(nowDate, 1) : nowDate;
  // As a column OFFSET from the week start, so the custom view's out-of-week
  // columns can host the now-line too; -1 when "now" isn't on screen at all.
  const nowOffset = differenceInDays(startOfDay(nowOwnerDate), weekStart);
  const nowColIdx = visibleCols.includes(nowOffset) ? nowOffset : -1;
  const liveLineOnScreen = nowColIdx >= 0 && nowInView;

  // Show a "Go to Live" pill whenever the red now-line has scrolled out of the
  // visible area (mirrors the widget). Clicking it scrolls the line back into view.
  const recomputeLiveBtn = useCallback(() => {
    const line = nowLineRef.current;
    if (!line) { setShowLiveBtn(false); return; }
    const lineRect = line.getBoundingClientRect();
    // Fixed viewport bounds: below the sticky app header (~56px), above the bottom.
    const topBound = 96;
    const bottomBound = window.innerHeight - 32;
    const visible = lineRect.top >= topBound && lineRect.top <= bottomBound;
    setShowLiveBtn(!visible);
  }, []);

  // Away from "now" entirely â†’ the pill is the way back, so it should always be
  // offered (there's no now-line on screen to scroll to at all). Day view is away
  // whenever the shown day isn't today; week view whenever the week differs.
  const viewingAnotherWeek = calendarView === 'day'
    ? !isSameDay(currentDate, nowOwnerDate)
    : viewedWeekKey !== currentRealWeekKey;

  useEffect(() => {
    if (viewingAnotherWeek) { setShowLiveBtn(true); return; }
    if (!liveLineOnScreen) { setShowLiveBtn(false); return; }
    recomputeLiveBtn();
    const onScroll = () => recomputeLiveBtn();
    // Capture true so it also catches scrolling on inner overflow containers.
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll, { capture: true } as EventListenerOptions);
      window.removeEventListener('resize', onScroll);
    };
  }, [viewingAnotherWeek, liveLineOnScreen, recomputeLiveBtn, nowTick, calendarView, viewedWeekKey]);

  // Set when the pill is pressed from a week that has no now-line: we navigate
  // home first, then scroll once the line actually exists in the DOM.
  const pendingLiveScrollRef = useRef(false);

  const scrollToLive = useCallback(() => {
    if (nowLineRef.current) {
      nowLineRef.current.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setShowLiveBtn(false);
      return;
    }
    // No line on screen (other week / month view / analysis) â†’ jump to now first.
    pendingLiveScrollRef.current = true;
    setDirection(0);
    setCurrentDate(new Date());
    setCalendarView('week');
    setShowFocusAnalysis(false);
  }, []);

  // Finish a pending jump: the week slider animates the new week in, so the line
  // isn't mounted on the next tick — poll a few frames until it appears.
  useEffect(() => {
    if (!pendingLiveScrollRef.current) return;
    let frames = 0;
    let raf = 0;
    const tryScroll = () => {
      if (!pendingLiveScrollRef.current) return;
      const line = nowLineRef.current;
      if (line) {
        pendingLiveScrollRef.current = false;
        line.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setShowLiveBtn(false);
        return;
      }
      if (++frames > 90) { pendingLiveScrollRef.current = false; return; } // give up (~1.5s)
      raf = requestAnimationFrame(tryScroll);
    };
    raf = requestAnimationFrame(tryScroll);
    return () => cancelAnimationFrame(raf);
  }, [viewedWeekKey, calendarView, showFocusAnalysis, liveLineOnScreen]);
  const focusElapsedSeconds = getFocusTimerElapsedSeconds(focusTimer, nowTick);
  const focusRemainingSeconds = Math.max(0, focusTimer.plannedSeconds - focusElapsedSeconds);
  const focusProgressPct = Math.min(100, Math.max(0, (focusElapsedSeconds / focusTimer.plannedSeconds) * 100));
  const activeFocusDayKey = focusTimer.sessionStartedAt ? focusDayKey(focusTimer.sessionStartedAt, focusDayStartHour) : '';
  const focusStats = useMemo(() => {
    const todayFocusKey = focusDayKey(new Date(nowTick), focusDayStartHour);
    const perDay = days.map(day => {
      const key = dateKey(day);
      const loggedSeconds = sumFocusSecondsForDay(focusSessions, day, focusDayStartHour);
      const activeSeconds = activeFocusDayKey === key ? focusElapsedSeconds : 0;
      const sessions = focusSessions.filter(session => focusDayKey(session.endedAt, focusDayStartHour) === key && isCompletedFocusSession(session)).length;
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
      todaySeconds: perDay.find(day => day.key === todayFocusKey)?.seconds ?? 0,
    };
  }, [activeFocusDayKey, focusElapsedSeconds, days, focusSessions, focusDayStartHour, nowTick]);

  // â”€â”€ Focus analysis (month / year) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const focusAnalysis = useMemo(() => {
    const byDaySeconds = new Map<string, number>();
    const byDaySessions = new Map<string, number>();
    for (const s of focusSessions) {
      const k = focusDayKey(s.endedAt, focusDayStartHour);
      byDaySeconds.set(k, (byDaySeconds.get(k) ?? 0) + s.durationSeconds);
      if (isCompletedFocusSession(s)) byDaySessions.set(k, (byDaySessions.get(k) ?? 0) + 1);
    }
    const completedSessions = focusSessions.filter(isCompletedFocusSession);

    // Week view — every day of the cursored week with its exact logged time.
    const aWeekStart = startOfWeek(analysisWeekCursor, { weekStartsOn });
    const aWeekEnd   = endOfWeek(analysisWeekCursor, { weekStartsOn });
    const weekDays = eachDayOfInterval({ start: aWeekStart, end: aWeekEnd }).map(d => {
      const k = dateKey(d);
      return {
        date: d,
        key: k,
        seconds: byDaySeconds.get(k) ?? 0,
        sessions: byDaySessions.get(k) ?? 0,
      };
    });
    const wkSeconds     = weekDays.reduce((s, d) => s + d.seconds, 0);
    const wkSessions    = weekDays.reduce((s, d) => s + d.sessions, 0);
    const wkActiveDays  = weekDays.filter(d => d.seconds > 0).length;
    const wkMaxSeconds  = Math.max(1, ...weekDays.map(d => d.seconds));
    const wkBestDay     = weekDays.reduce((b, d) => (d.seconds > b.seconds ? d : b), weekDays[0]);
    // Average across days that actually had focus, not a flat /7 — a blank
    // Sunday shouldn't drag down what a working day really looks like.
    const wkAvgActive   = wkActiveDays > 0 ? Math.floor(wkSeconds / wkActiveDays) : 0;

    // Month view
    const monthStart = startOfMonth(analysisMonthCursor);
    const monthEnd = endOfMonth(analysisMonthCursor);
    const monthGridDays = eachDayOfInterval({
      start: startOfWeek(monthStart, { weekStartsOn }),
      end: endOfWeek(monthEnd, { weekStartsOn }),
    });
    const monthDaysInMonth = eachDayOfInterval({ start: monthStart, end: monthEnd });
    const monthSeconds = monthDaysInMonth.reduce((sum, d) => sum + (byDaySeconds.get(dateKey(d)) ?? 0), 0);
    const monthSessions = monthDaysInMonth.reduce((sum, d) => sum + (byDaySessions.get(dateKey(d)) ?? 0), 0);
    const monthActiveDays = monthDaysInMonth.filter(d => (byDaySeconds.get(dateKey(d)) ?? 0) > 0).length;
    const monthMaxSeconds = Math.max(1, ...monthDaysInMonth.map(d => byDaySeconds.get(dateKey(d)) ?? 0));
    const monthBestDay = monthDaysInMonth.reduce(
      (best, d) => (byDaySeconds.get(dateKey(d)) ?? 0) > (byDaySeconds.get(dateKey(best)) ?? 0) ? d : best,
      monthDaysInMonth[0],
    );

    // Year view
    const monthsOfYear = Array.from({ length: 12 }, (_, m) => new Date(analysisYearCursor, m, 1));
    const monthTotals = monthsOfYear.map(m => {
      const dayList = eachDayOfInterval({ start: startOfMonth(m), end: endOfMonth(m) });
      const seconds = dayList.reduce((sum, d) => sum + (byDaySeconds.get(dateKey(d)) ?? 0), 0);
      const sessions = dayList.reduce((sum, d) => sum + (byDaySessions.get(dateKey(d)) ?? 0), 0);
      const activeDays = dayList.filter(d => (byDaySeconds.get(dateKey(d)) ?? 0) > 0).length;
      return { month: m, seconds, sessions, activeDays };
    });
    const yearSeconds = monthTotals.reduce((sum, m) => sum + m.seconds, 0);
    const yearSessions = monthTotals.reduce((sum, m) => sum + m.sessions, 0);
    const yearActiveDays = monthTotals.reduce((sum, m) => sum + m.activeDays, 0);
    const yearMaxSeconds = Math.max(1, ...monthTotals.map(m => m.seconds));
    const yearBestMonth = monthTotals.reduce((best, m) => m.seconds > best.seconds ? m : best, monthTotals[0]);

    // Streaks (all-time, based on any day with logged focus time)
    const activeDayKeys = new Set(Array.from(byDaySeconds.entries()).filter(([, secs]) => secs > 0).map(([k]) => k));
    let currentStreak = 0;
    {
      let cursorDate = new Date(`${focusDayKey(new Date(), focusDayStartHour)}T00:00:00`);
      while (activeDayKeys.has(dateKey(cursorDate))) {
        currentStreak++;
        cursorDate = new Date(cursorDate.getTime() - 86400000);
      }
    }
    let longestStreak = 0, run = 0;
    let prevDate: Date | null = null;
    for (const k of Array.from(activeDayKeys).sort()) {
      const d = new Date(`${k}T00:00:00`);
      run = (prevDate && d.getTime() - prevDate.getTime() === 86400000) ? run + 1 : 1;
      longestStreak = Math.max(longestStreak, run);
      prevDate = d;
    }

    const allTimeSeconds = Array.from(byDaySeconds.values()).reduce((a, b) => a + b, 0);
    const allTimeSessions = completedSessions.length;
    const avgSessionLength = allTimeSessions > 0
      ? Math.floor(completedSessions.reduce((s, x) => s + x.durationSeconds, 0) / allTimeSessions)
      : 0;

    return {
      byDaySeconds, byDaySessions,
      aWeekStart, aWeekEnd, weekDays, wkSeconds, wkSessions, wkActiveDays, wkMaxSeconds, wkBestDay, wkAvgActive,
      monthGridDays, monthStart, monthEnd, monthSeconds, monthSessions, monthActiveDays, monthMaxSeconds, monthBestDay,
      monthTotals, yearSeconds, yearSessions, yearActiveDays, yearMaxSeconds, yearBestMonth,
      currentStreak, longestStreak, allTimeSeconds, allTimeSessions, avgSessionLength,
    };
  }, [focusSessions, analysisWeekCursor, analysisMonthCursor, analysisYearCursor, weekStartsOn, focusDayStartHour]);

  // The memo above only counts *logged* sessions. A session that's still running
  // hasn't been written yet, so fold its elapsed time into the day it belongs to —
  // otherwise the week breakdown reads 0m for a day you're actively focusing on
  // while the header strip (which does include it) shows the real number.
  const weekAnalysisLive = useMemo(() => {
    const dayList = focusAnalysis.weekDays.map(d => ({
      ...d,
      seconds: d.seconds + (activeFocusDayKey === d.key ? focusElapsedSeconds : 0),
    }));
    const total  = dayList.reduce((s, d) => s + d.seconds, 0);
    const active = dayList.filter(d => d.seconds > 0).length;
    return {
      days: dayList,
      seconds: total,
      activeDays: active,
      maxSeconds: Math.max(1, ...dayList.map(d => d.seconds)),
      avgActive: active > 0 ? Math.floor(total / active) : 0,
      bestKey: dayList.reduce((b, d) => (d.seconds > b.seconds ? d : b), dayList[0]).key,
    };
  }, [focusAnalysis.weekDays, activeFocusDayKey, focusElapsedSeconds]);

  // Same idea for the month tab's total: the in-progress session isn't logged yet.
  const monthLiveExtraSeconds = useMemo(() => {
    if (!activeFocusDayKey || !focusElapsedSeconds) return 0;
    const d = new Date(`${activeFocusDayKey}T00:00:00`);
    return isSameMonth(d, analysisMonthCursor) ? focusElapsedSeconds : 0;
  }, [activeFocusDayKey, focusElapsedSeconds, analysisMonthCursor]);

  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
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

    // Live push of the shared file database, so a change made in the widget shows
    // up here at once instead of on the next poll. Events are only adopted when
    // this window is idle — applying them mid-edit or mid-drag would yank the item
    // out from under the user.
    let dbStream: EventSource | null = null;
    try {
      dbStream = new EventSource('/api/db-stream');
      dbStream.addEventListener('focus-sessions', (evt) => {
        try {
          const sessions = safeFocusSessions(JSON.parse((evt as MessageEvent).data));
          setFocusSessions(sessions);
          localStorage.setItem(FOCUS_SESSIONS_KEY, JSON.stringify(sessions));
        } catch (_) { /* ignore */ }
      });
      dbStream.addEventListener('events', (evt) => {
        if (uiBusyRef.current) return;
        // Our own save echoing back, or a save still settling — don't rewind.
        if (Date.now() - lastLocalEventsWriteRef.current < 3000) return;
        try {
          const data = JSON.parse((evt as MessageEvent).data);
          if (!data || typeof data !== 'object' || Object.keys(data).length === 0) return;
          const next = migrateEvents(data as PlannerData).events;
          if (JSON.stringify(next) === JSON.stringify(eventsRef.current)) return;
          writeEvents(next);
        } catch (_) { /* ignore */ }
      });
      dbStream.addEventListener('tasks', (evt) => {
        if (uiBusyRef.current) return;
        if (Date.now() - lastLocalTasksWriteRef.current < 3000) return;
        try {
          const data = JSON.parse((evt as MessageEvent).data);
          if (!data || typeof data !== 'object') return;
          // Unlike events an EMPTY map is legitimate here (every task done and
          // cleared), so this only guards against a malformed payload.
          const next = coerceTasks(data);
          if (JSON.stringify(next) === JSON.stringify(tasksRef.current)) return;
          writeTasks(next);
        } catch (_) { /* ignore */ }
      });
    } catch (_) { /* fall back to the poll */ }

    // Safety net only — the stream is what makes this feel instant.
    const focusPollId = setInterval(loadFocusSessions, 15000);
    return () => { clearInterval(focusPollId); if (dbStream) dbStream.close(); };
  }, [writeEvents, writeTasks]);

  // The running timer is shared through the backend so the main window and the
  // side widget always show the SAME live session (localStorage `storage` events
  // don't reliably cross separate windows). `lastTimerJsonRef` holds the last
  // payload we sent or received, so polling never echoes our own write back.
  const lastTimerJsonRef = useRef<string | null>(null);
  // Stays false until the backend's running-timer state has been loaded once. While
  // false we must NOT push our (possibly empty/stale) local state to the backend, or
  // we'd clobber a live session that another window owns before we've pulled it.
  const timerHydratedRef = useRef(false);
  // Timestamp of our last local timer change. Right after we change the timer here
  // (e.g. Pause), the server hasn't stored our POST yet, so an in-flight pull can
  // read the OLD state and write it back — resuming a timer we just stopped. For a
  // short grace window after a local change we ignore differing pulls.
  const lastLocalTimerChangeRef = useRef(0);
  const lastTimerPushKeyRef = useRef<string | null>(null);
  /** When this window last WROTE the timer — anything older is a stale echo. */
  const lastLocalPushAtRef = useRef(0);
  /** Pending coalesced write for duration-only nudges (the +/- buttons). */
  const timerPushTimeoutRef = useRef<number | null>(null);
  const lastTransitionKeyRef = useRef<string | null>(null);
  // When this window last saved events, and whether the user is mid-interaction —
  // both gate whether a pushed database change may be adopted here.
  const lastLocalEventsWriteRef = useRef(0);
  const lastLocalTasksWriteRef = useRef(0);
  const uiBusyRef = useRef(false);
  useEffect(() => {
    setFocusTimer(loadLocalFocusTimer());

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === FOCUS_TIMER_KEY) setFocusTimer(loadLocalFocusTimer());
    };
    window.addEventListener('storage', handleStorage);

    // `live` = arrived over the stream, i.e. the file's actual content just after
    // a write. Only a *polled* read can be stale, so only a poll needs the grace
    // window below. Applying it to stream pushes too was the bug: any local
    // change in the previous 4s (setting the minutes, a session reset) made an
    // external start sit unapplied for seconds, and the widget — whose grace
    // wasn't armed — reacted instantly, so the cue sounded twice.
    const applyTimerFromServer = (data: unknown, live = false) => {
      if (!data || typeof data !== 'object' || Object.keys(data).length === 0) { timerHydratedRef.current = true; return; }
      const incoming = coerceFocusTimer(data);
      const json = focusTimerIdentity(incoming);
      timerHydratedRef.current = true;
      if (json === lastTimerJsonRef.current) return; // our own echo / no change
      // Stamped before our own last write ⇒ it IS an earlier write of ours coming
      // back late. Applying it would undo a newer local change — the stutter when
      // nudging the duration quickly. True of streamed events too: "live" means it
      // arrived promptly, not that it describes a newer state.
      if (incoming.updatedAt && incoming.updatedAt < lastLocalPushAtRef.current) return;
      // Don't let a stale server read clobber a change we just made locally
      // (the server may not have stored our push yet).
      if (!live && Date.now() - lastLocalTimerChangeRef.current < 4000) return;
      lastTimerJsonRef.current = json;
      lastTimerPushKeyRef.current = focusTimerPushKey(incoming);
      lastTransitionKeyRef.current = focusTimerTransitionKey(incoming);
      setFocusTimer(incoming);
    };

    const pullTimer = () => {
      fetch('/api/focus-timer')
        .then(r => r.json())
        .then(d => applyTimerFromServer(d))
        .catch(() => { timerHydratedRef.current = true; });
    };
    pullTimer();

    // Live push: a start/pause from the widget or the system-wide hotkey lands
    // here the instant the shared file changes, with no tick to wait for.
    let stream: EventSource | null = null;
    try {
      stream = new EventSource('/api/focus-timer/stream');
      stream.onmessage = (evt) => {
        try { applyTimerFromServer(JSON.parse(evt.data), true); } catch (_) { /* ignore */ }
      };
    } catch (_) { /* fall back to the poll below */ }

    // Safety net if the stream drops (server restart, HMR); the stream is what
    // makes it feel instant, so this can stay slow.
    const pollId = setInterval(pullTimer, 1500);
    // Checkpoint a running session's elapsed time into durable state every few seconds
    // so closing the app mid-session never loses progress (previously it was only
    // committed when the session ended). Folds elapsed into accumulatedSeconds and
    // re-anchors lastStartedAt so the persisted number is always current.
    const checkpointId = setInterval(() => {
      setFocusTimer(prev => checkpointFocusTimer(prev));
    }, 5000);
    return () => {
      window.removeEventListener('storage', handleStorage);
      clearInterval(pollId);
      clearInterval(checkpointId);
      if (stream) stream.close();
    };
  }, []);

  const persistFocusSessions = useCallback((sessions: FocusSession[], force = false) => {
    localStorage.setItem(FOCUS_SESSIONS_KEY, JSON.stringify(sessions));
    fetch(`/api/focus-sessions${force ? '?force=1' : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sessions),
    }).catch(err => console.error('Failed to save focus sessions:', err));
  }, []);

  const commitFocusDayDuration = useCallback((dateKeyVal: string, dateVal: Date, newSeconds: number) => {
    const remaining = focusSessions.filter(s => focusDayKey(s.endedAt, focusDayStartHour) !== dateKeyVal);
    const updated = [...remaining];

    if (newSeconds > 0) {
      const endIso = `${dateKeyVal}T12:00:00.000Z`;
      const startIso = new Date(new Date(endIso).getTime() - newSeconds * 1000).toISOString();
      const newSession: FocusSession = {
        id: `manual-${dateKeyVal}-${newSeconds}`,
        startedAt: startIso,
        endedAt: endIso,
        durationSeconds: newSeconds,
        plannedSeconds: newSeconds,
      };
      updated.push(newSession);
    }

    setFocusSessions(updated);
    persistFocusSessions(updated, true);
  }, [focusSessions, focusDayStartHour, persistFocusSessions]);

  const submittingEditRef = useRef(false);

  const startEditingFocusDay = useCallback((dKey: string, dDate: Date, currentSecs: number) => {
    submittingEditRef.current = false;
    setEditingFocusDayKey(dKey);
    setEditingFocusInput(currentSecs > 0 ? formatFocusDuration(currentSecs) : '');
  }, []);

  const submitFocusDayEdit = useCallback((dKey: string, dDate: Date, currentSecs: number, rawVal?: string) => {
    if (submittingEditRef.current) return;
    submittingEditRef.current = true;

    const textToParse = rawVal !== undefined ? rawVal : editingFocusInput;
    const parsedSecs = parseDurationInput(textToParse);
    setEditingFocusDayKey(null);

    if (parsedSecs !== currentSecs) {
      setConfirmFocusModal({
        date: dDate,
        dateKey: dKey,
        label: format(dDate, 'EEEE, MMMM d, yyyy'),
        oldSeconds: currentSecs,
        newSeconds: parsedSecs,
      });
    }
  }, [editingFocusInput]);

  const completeFocusSession = useCallback((durationSeconds?: number, auto = false, opts?: { endedAt?: Date; id?: string }) => {
    const duration = Math.floor(durationSeconds ?? getFocusTimerElapsedSeconds(focusTimer));
    if (duration <= 0) {
      setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
      return;
    }

    // `opts.endedAt` is for a session recovered after the machine was switched
    // off: it ended when the PC did, not when we noticed on the next launch.
    const endedAt = opts?.endedAt ?? new Date();
    const startedAt = focusTimer.sessionStartedAt
      ? new Date(focusTimer.sessionStartedAt)
      : new Date(endedAt.getTime() - duration * 1000);

    const session: FocusSession = {
      // Auto-completions get a deterministic id so the main window and the widget
      // (which both hit zero independently) collapse into a single logged session.
      id: opts?.id ?? (auto ? autoSessionId(focusTimer.sessionStartedAt, focusTimer.plannedSeconds) : focusUid()),
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

  // â”€â”€ Shutdown / sleep recovery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Nothing of ours runs while the PC is off, so a session that was interrupted
  // by a shutdown has to be reconstructed on the next launch — from the
  // heartbeat, which is the last moment any window saw the session alive. The
  // session is then STOPPED at that moment with the time it had actually run,
  // instead of being resumed and auto-completed for its full planned length
  // hours later (which credited a whole hour to the wrong day).
  const focusTimerRef = useRef(focusTimer);
  focusTimerRef.current = focusTimer;
  // Set whenever the timer stops on its OWN (hit zero, or a session recovered
  // after a shutdown). The cue effect below reads it to tell that transition
  // apart from a real pause/stop: completing RESETS the timer, so the remaining
  // seconds jump back to full and can't distinguish the two.
  const focusAutoEndedRef = useRef(false);
  const completeFocusSessionRef = useRef(completeFocusSession);
  completeFocusSessionRef.current = completeFocusSession;
  // The sessionStartedAt we've confirmed is genuinely live. The completion
  // effect below stands down until this matches — otherwise, on launch, it would
  // fire before the check and log the ghost session at full length. State rather
  // than a ref so confirming it re-runs that effect immediately.
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
          // Too short to be worth a record — just stop the timer.
          setFocusTimer(prev => ({ ...DEFAULT_FOCUS_TIMER, plannedSeconds: prev.plannedSeconds, lastPausedAt: new Date().toISOString() }));
        }
      })
      // No server to ask â†’ don't hold the normal completion hostage.
      .catch(() => setFocusLiveSession(session));
  }, []);

  // Check the moment a session appears (launch, or a start from the widget), and
  // keep the stamp fresh after that. The interval also catches the machine
  // sleeping with the windows open: the heartbeat goes stale either way.
  useEffect(() => {
    runFocusHeartbeat();
  }, [runFocusHeartbeat, focusTimer.isRunning, focusTimer.sessionStartedAt]);

  useEffect(() => {
    const id = setInterval(runFocusHeartbeat, FOCUS_HEARTBEAT_INTERVAL_MS);
    return () => clearInterval(id);
  }, [runFocusHeartbeat]);

  useEffect(() => {
    localStorage.setItem(FOCUS_TIMER_KEY, JSON.stringify(focusTimer));
    // Don't push to the backend until we've hydrated from it — otherwise our initial
    // (empty/stale) state could overwrite a live session owned by another window.
    if (!timerHydratedRef.current) return;
    // Push to the shared backend (skip if this value just arrived from a pull).
    const json = focusTimerIdentity(focusTimer);
    if (json === lastTimerJsonRef.current) return;
    // A running-session checkpoint isn't a real change — pushing it would stomp a
    // start/pause made from the widget or the system-wide hotkey.
    const pushKey = focusTimerPushKey(coerceFocusTimer(focusTimer));
    if (pushKey === lastTimerPushKeyRef.current) return;
    lastTimerPushKeyRef.current = pushKey;
    lastTimerJsonRef.current = json;
    lastLocalTimerChangeRef.current = Date.now();

    // Duration nudges are coalesced into one write (each used to cost a file
    // write, a backup and a broadcast to both windows); a start/pause still goes
    // out immediately, because the other window's cue depends on it.
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

    if (timerPushTimeoutRef.current !== null) {
      window.clearTimeout(timerPushTimeoutRef.current);
      timerPushTimeoutRef.current = null;
    }
    if (durationOnly) {
      timerPushTimeoutRef.current = window.setTimeout(() => { timerPushTimeoutRef.current = null; send(); }, 220);
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
    // A session we haven't confirmed as live may be the ghost of one the PC was
    // switched off during; the heartbeat check decides, and it stops the timer
    // itself if so. Completing here first would credit the full planned time to
    // whenever the app happened to be reopened.
    const liveSession = focusLiveSession === focusTimer.sessionStartedAt;
    if (focusTimer.isRunning && liveSession && focusRemainingSeconds <= 0 && !focusCompleteRef.current) {
      focusCompleteRef.current = true;
      if (claimFocusCompletion()) {
        setFocusCelebrate(true);
        window.setTimeout(() => setFocusCelebrate(false), 2600);
      }
      // The chime is claimed through the server for the same reason the cues are:
      // the two windows are different browser engines and can't see each other's
      // localStorage, so a local claim would always succeed in both.
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
  // buttons, so a toggle from the widget or the system-wide hotkey sounds too.
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
      // A fresh session id (or none before) means "start"; same one means "resume".
      slot = session && session === prevSession ? 'resume' : 'start';
    } else if (!running && prevRunning) {
      // Hitting zero is a completion, not a pause: the session-complete chime
      // covers that one, so this must not also fire the pause cue.
      if (focusAutoEndedRef.current) focusAutoEndedRef.current = false;
      else slot = 'pause';
    }
    if (!slot) return;
    const cue = focusCuesRef.current[slot];
    if (cue === 'none') return;
    // If the claim can't be reached (dev-server restart), only the window that
    // actually performed the toggle sounds it — otherwise both do, and you hear
    // the cue twice.
    claimFocusCue(focusCueKey(slot, focusTimer), () => playFocusCue(cue), {
      playIfUnreachable: Date.now() - lastLocalPushAtRef.current < 3000,
    });
  }, [focusTimer, focusRemainingSeconds]);

  const startFocus = () => {
    const startedAt = new Date().toISOString();
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

  const setFocusMinutes = (minutes: number) => {
    const safeMinutes = Math.max(1, Math.floor(minutes));
    setFocusTimer(prev => ({ ...prev, plannedSeconds: safeMinutes * 60 }));
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

  // â”€â”€ Persistence & Backend Sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const isInitialMount = useRef(true);
  const settingsLoaded = useRef(false);

  useEffect(() => {
    // Initial load from localStorage
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) { try { setEvents(migrateEvents(JSON.parse(saved) as PlannerData).events); } catch (_) {} }

    // Fetch from backend file database
    fetch('/api/events')
      .then(r => r.json())
      .then(data => {
        if (data && typeof data === 'object' && Object.keys(data).length > 0) {
          setEvents(migrateEvents(data as PlannerData).events);
        }
      })
      .catch(err => console.error('Failed to load events from backend database:', err))
      .finally(() => { eventsLoadedRef.current = true; setEventsLoading(false); });

    // Tasks: same shape of load. localStorage first for an instant paint, then
    // the file DB, which is the source of truth shared with the other window.
    const savedTasks = localStorage.getItem(TASKS_STORAGE_KEY);
    if (savedTasks) { try { writeTasks(coerceTasks(JSON.parse(savedTasks))); } catch (_) {} }
    fetch('/api/tasks')
      .then(r => r.json())
      .then(data => {
        if (data && typeof data === 'object') writeTasks(coerceTasks(data));
      })
      .catch(err => console.error('Failed to load tasks from backend database:', err))
      .finally(() => { tasksLoadedRef.current = true; });

    applySettingsSnapshotRef.current(loadSettingsLocal());
    const savedZoom = parseFloat(localStorage.getItem(ZOOM_KEY) || '');
    if (Number.isFinite(savedZoom)) setAppZoom(clampZoom(savedZoom));

    // Backend is the source of truth for settings so both windows stay in sync.
    fetch('/api/settings')
      .then(r => r.json())
      .then((s) => {
        if (s && typeof s === 'object') {
          // Coerce once and apply EVERYTHING. The old hand-written field list
          // silently omitted the two side-window presets, so this page loaded
          // them from its own localStorage, ignored the newer values on the
          // server, and then pushed its stale copy straight back over them —
          // which is why that one setting kept reverting on every reload.
          applySettingsSnapshotRef.current(coerceSettings(s));
        }
      })
      .catch(err => console.error('Failed to load settings from backend:', err))
      .finally(() => {
        settingsLoaded.current = true;

        fetch('/api/google-auth/status')
          .then(r => r.json())
          .then(status => {
            setGCalStatus(status);
            if (status.clientId) setClientIdInput(status.clientId);
            if (status.clientSecret) setClientSecretInput(status.clientSecret);
            if (status.authenticated) {
              triggerGCalSync();
            }
          })
          .catch(err => console.error('Failed to load Google Auth status on startup:', err));
      });
  }, []);

  // Sync settings when returning to main planner route
  useEffect(() => {
    if (location === '/' && settingsLoaded.current) {
      // Returning from the settings page: adopt the whole saved snapshot, not a
      // subset — see applySettingsSnapshot for why a partial list corrupts data.
      fetch('/api/settings')
        .then(r => r.json())
        .then((s) => {
          if (s && typeof s === 'object') applySettingsSnapshotRef.current(coerceSettings(s));
        })
        .catch(() => {});
    }
  }, [location]);

  // Subscribe to live settings updates broadcast from anywhere (Settings page, shortcuts, etc.)
  useEffect(() => {
    return subscribeSettingsChange(s => {
      // Adopt the WHOLE snapshot. Adopting a subset was silently destructive:
      // this page re-broadcasts everything it holds, so any field it failed to
      // adopt was immediately pushed back over the change that had just been
      // made (calendarView, the custom-view day counts and the task checkbox
      // shape all reverted this way).
      applySettingsSnapshotRef.current(s);
    });
  }, []);

  // Sync document root class with darkMode state
  useEffect(() => {
    applyDarkModeClass(darkMode);
  }, [darkMode]);

  // Persist settings to the shared backend whenever any of them change (after initial load).
  useEffect(() => {
    if (!settingsLoaded.current) return;
    broadcastSettingsChange({
      interval, darkMode, darkPreset, lightPreset, widgetDarkPreset, widgetLightPreset,
      eventColorStyle, sidebarStyle,
      timeFormat, weekStartsOn, dayStartH, dayEndH, calendarView, customDaysBefore, customDaysAfter,
      focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup,
      tasksPanelOpen, tasksPanelWidth, showTaskRow, taskColor, taskCheckboxShape, taskFilters, googleTasksSync,
      prayer
    });
  }, [interval, darkMode, darkPreset, lightPreset, widgetDarkPreset, widgetLightPreset, eventColorStyle, sidebarStyle, timeFormat, weekStartsOn, dayStartH, dayEndH, calendarView, customDaysBefore, customDaysAfter, focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup, tasksPanelOpen, tasksPanelWidth, showTaskRow, taskColor, taskCheckboxShape, taskFilters, googleTasksSync, prayer]);

  useEffect(() => { localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(shortcuts)); }, [shortcuts]);

  // Shortcut recorder: while a row is armed, the next real keypress becomes its
  // binding. Capture phase + stopPropagation so nothing else reacts to that key.
  useEffect(() => {
    if (!recordingAction) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { setRecordingAction(null); return; }
      const combo = eventToCombo(e);
      if (!combo) return; // still holding modifiers — wait for the real key
      // Refuse combos the OS owns — binding Alt+F4 would make the shortcut close
      // the app rather than run the action.
      if (isReservedCombo(combo)) {
        showToast(`${formatCombo(combo)} is reserved by Windows — pick another key.`, 'error');
        setRecordingAction(null);
        return;
      }
      setShortcuts(prev => ({ ...prev, [recordingAction]: combo }));
      setRecordingAction(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recordingAction, showToast]);

  // Refresh backup status whenever the drawer opens so the counts are current.
  useEffect(() => {
    if (!settingsOpen) return;
    fetch('/api/auto-backup')
      .then(r => r.json())
      .then(s => setBackupStatus({ count: Number(s.count) || 0, lastBackupAt: s.lastBackupAt ?? null }))
      .catch(() => {});
  }, [settingsOpen]);

  const runBackupNow = useCallback(() => {
    fetch('/api/auto-backup', { method: 'POST' })
      .then(r => r.json().then(body => ({ ok: r.ok, body })))
      .then(({ ok, body }) => {
        if (!ok) { showToast(body?.error || 'Backup failed.', 'error'); return; }
        showToast(`Backup saved (${body.count} items).`, 'success');
        return fetch('/api/auto-backup')
          .then(r => r.json())
          .then(s => setBackupStatus({ count: Number(s.count) || 0, lastBackupAt: s.lastBackupAt ?? null }));
      })
      .catch(() => showToast('Couldn\'t reach the server to back up.', 'error'));
  }, [showToast]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(events));

    // Avoid overwriting backend on initial mount before fetch resolves
    if (isInitialMount.current) {
      isInitialMount.current = false;
      return;
    }

    lastLocalEventsWriteRef.current = Date.now();
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(events),
    }).catch(err => console.error('Failed to save events to backend database:', err));
  }, [events]);

  // Same for tasks. Gated on the initial load having resolved so an empty map is
  // never written over a populated tasks.json.
  const isInitialTasksMount = useRef(true);
  useEffect(() => {
    if (isInitialTasksMount.current) { isInitialTasksMount.current = false; return; }
    if (!tasksLoadedRef.current) return;
    localStorage.setItem(TASKS_STORAGE_KEY, JSON.stringify(tasks));
    lastLocalTasksWriteRef.current = Date.now();
    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tasks),
    }).catch(err => console.error('Failed to save tasks to backend database:', err));
  }, [tasks]);

  // â”€â”€ Undo / Redo history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    eventsRef.current = prevState;
    setEvents(prevState);
    setHistVersion(v => v + 1);
  }, []);

  const redo = useCallback(() => {
    if (!redoStack.current.length) return;
    const nextState = redoStack.current.pop()!;
    undoStack.current.push(eventsRef.current);
    skipHistoryRef.current = true;
    prevEventsRef.current = nextState;
    eventsRef.current = nextState;
    setEvents(nextState);
    setHistVersion(v => v + 1);
  }, []);

  const undoRef = useRef(undo); useEffect(() => { undoRef.current = undo; }, [undo]);
  const redoRef = useRef(redo); useEffect(() => { redoRef.current = redo; }, [redo]);

  // â”€â”€ Backup & Restore â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Covers all three database files (events, settings, focus-sessions) so a
  // single exported file is a complete snapshot of the whole app's data.
  const BACKUP_FORMAT_VERSION = 2;

  const currentSettingsSnapshot = (): AppSettings => ({
    interval, darkMode, darkPreset, lightPreset, widgetDarkPreset, widgetLightPreset,
    eventColorStyle, sidebarStyle,
    timeFormat, weekStartsOn, dayStartH, dayEndH, calendarView, customDaysBefore, customDaysAfter,
    focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup,
    tasksPanelOpen, tasksPanelWidth, showTaskRow, taskColor, taskCheckboxShape, taskFilters, googleTasksSync,
    prayer
  });

  const applyImportedSettings = (raw: unknown, backupShortcuts?: unknown) => {
    const restored = coerceSettings({
      ...currentSettingsSnapshot(),
      ...(raw && typeof raw === 'object' ? raw : {}),
      ...(backupShortcuts ? { shortcuts: backupShortcuts } : {}),
    });

    setIntervalOpt(restored.interval);
    setDarkMode(restored.darkMode);
    setDarkPreset(restored.darkPreset);
    setLightPreset(restored.lightPreset);
    setWidgetDarkPreset(restored.widgetDarkPreset);
    setWidgetLightPreset(restored.widgetLightPreset);
    setEventColorStyle(restored.eventColorStyle);
    setSidebarStyle(restored.sidebarStyle);
    setTimeFormat(restored.timeFormat);
    setWeekStartsOn(restored.weekStartsOn);
    setDayStartH(restored.dayStartH);
    setDayEndH(restored.dayEndH);
    if (isCalendarView(restored.calendarView)) setCalendarView(restored.calendarView);
    setCustomDaysBefore(restored.customDaysBefore);
    setCustomDaysAfter(restored.customDaysAfter);
    setFocusDayStartHour(restored.focusDayStartHour);
    setFocusChime(restored.focusChime);
    setFocusCues(restored.focusCues);
    setShortcuts(restored.shortcuts);
    setAutoBackup(restored.autoBackup);
    setTasksPanelOpen(restored.tasksPanelOpen);
    setTasksPanelWidth(restored.tasksPanelWidth);
    setShowTaskRow(restored.showTaskRow);
    setTaskColor(restored.taskColor);
    if (restored.taskCheckboxShape) setTaskCheckboxShape(restored.taskCheckboxShape);
    setTaskFilters(canonicalFilters(restored.taskFilters));
    setGoogleTasksSync(restored.googleTasksSync);
    setPrayer(restored.prayer);
    broadcastSettingsChange(restored);
  };

  const exportBackup = () => {
    const backup = {
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      events,
      settings: currentSettingsSnapshot(),
      focusSessions,
    };
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(backup, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `weekly-planner-backup-${new Date().toISOString().split('T')[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
    showToast(`Backup exported (${Object.keys(events).length} items).`, 'success');
  };

  const importBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    // Always clear the input so re-picking the SAME file fires onChange again.
    const resetInput = () => { input.value = ''; };
    if (!file) { resetInput(); return; }
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        if (!parsed || typeof parsed !== 'object') {
          showToast('That file isn\'t a valid backup.', 'error');
          resetInput();
          return;
        }

        // Comprehensive backup (v2+): { events, settings, focusSessions }.
        // Legacy backup (v1): the file *is* the events map.
        const isComprehensive = 'events' in parsed && typeof parsed.events === 'object';
        const importedEvents: PlannerData = isComprehensive ? parsed.events : parsed;
        const s = isComprehensive ? parsed.settings : null;
        const sessions = isComprehensive && Array.isArray(parsed.focusSessions) ? parsed.focusSessions : null;

        const migrated = migrateEvents(importedEvents as PlannerData).events;
        const incoming = Object.keys(migrated).length;
        const existing = Object.keys(eventsRef.current).length;

        // Importing REPLACES everything — make that explicit before it happens.
        const ok = window.confirm(
          `Import this backup?\n\n` +
          `It will replace all ${existing} current item${existing === 1 ? '' : 's'} with ${incoming} item${incoming === 1 ? '' : 's'} from the file` +
          `${s ? ', and overwrite your settings' : ''}${sessions ? `, and replace your focus session history` : ''}.\n\n` +
          `This cannot be undone.`
        );
        if (!ok) { resetInput(); return; }

        // writeEvents (not setEvents) so eventsRef is hot immediately — a stale ref
        // here would let the very next edit rebuild from pre-import data.
        writeEvents(migrated);
        fetch('/api/events?force=1', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(migrated),
        }).catch(() => showToast('Imported locally, but saving to the server failed.', 'error'));

        if (s && typeof s === 'object') applyImportedSettings(s, parsed.shortcuts);

        if (sessions) {
          const safeSessions = safeFocusSessions(sessions);
          setFocusSessions(safeSessions);
          persistFocusSessions(safeSessions, true);
        }

        showToast(
          isComprehensive
            ? `Imported ${incoming} item${incoming === 1 ? '' : 's'}, settings and focus history.`
            : `Imported ${incoming} item${incoming === 1 ? '' : 's'}.`,
          'success'
        );
      } catch (err) {
        showToast('Couldn\'t read that backup file.', 'error');
      } finally {
        resetInput();
      }
    };
    reader.onerror = () => { showToast('Couldn\'t read that file.', 'error'); resetInput(); };
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
  useEffect(() => { menuPosRef.current = menuPos; }, [menuPos]);
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

  // â”€â”€ Close menu on outside click / Escape â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ Mouse coordinates tracking â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
    // Map the cursor to a VISIBLE slot, then back to the real week dayIndex —
    // in day view there is only one slot but it may stand for any day 0–6.
    const cols     = visibleColsRef.current;
    const colW     = rect.width / cols.length;
    const slot     = clamp(Math.floor((clientX - rect.left) / colW), 0, cols.length - 1);
    const dayIndex = cols[slot];
    const snapped  = clamp(yToMin(Math.max(0, clientY - rect.top - topBandsHeight), interval, dayStartH), dayStartMin, dayEndMin - POSITION_SNAP);
    return { dayIndex, slot, snappedMin: snapped };
  }, [interval, dayStartMin, dayEndMin, topBandsHeight]);

  // â”€â”€ Keyboard Shortcuts (Escape, Delete/Backspace, Copy/Paste) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While recording a new binding in Settings, swallow everything.
      if (recordingActionRef.current) return;
      const sc = shortcutsRef.current;
      const hit = (action: ShortcutAction) => matchesCombo(sc[action], e);

      // Undo / Redo (works even while focused elsewhere, but not inside text fields)
      const inTextField = document.activeElement instanceof HTMLTextAreaElement || document.activeElement instanceof HTMLInputElement;
      if (hit('undo') && !inTextField) {
        e.preventDefault();
        undoRef.current();
        return;
      }
      if (hit('redo') && !inTextField) {
        e.preventDefault();
        redoRef.current();
        return;
      }
      // Ctrl+Y stays as a permanent alias for redo (Windows convention).
      if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y') && !inTextField) {
        e.preventDefault();
        redoRef.current();
        return;
      }

      // â”€â”€ Rebindable navigation / view actions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      if (!inTextField) {
        const nav: Array<[ShortcutAction, () => void]> = [
          ['prevWeek',      () => navRef.current.prev()],
          ['nextWeek',      () => navRef.current.next()],
          ['today',         () => navRef.current.today()],
          ['goToLive',      () => navRef.current.goToLive()],
          ['toggleView',    () => navRef.current.toggleView()],
          ['focusAnalysis', () => navRef.current.toggleAnalysis()],
          ['openSettings',  () => navRef.current.toggleSettings()],
          ['openWidget',    () => navRef.current.openWidget()],
          ['newEvent',      () => navRef.current.newEvent()],
          ['toggleTimer',   () => navRef.current.toggleTimer()],
          ['help',          () => navRef.current.toggleHelp()],
        ];
        for (const [action, run] of nav) {
          if (hit(action)) { e.preventDefault(); run(); return; }
        }
      }

      const active = document.activeElement;
      // Do not trigger shortcuts if typing inside text fields
      if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) return;

      // Escape: Close the shortcut sheet first, then clear selection & menus
      if (e.key === 'Escape') {
        let changed = false;
        if (showShortcutHelpRef.current) {
          setShowShortcutHelp(false);
          e.preventDefault();
          return;
        }
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

      // Delete: Remove selected, hovered, menu, or editing events.
      // Backspace stays a permanent alias so the key always works as expected.
      if (hit('delete') || e.key === 'Backspace') {
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
          applyDeleteManyRef.current(idsToDelete);

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

      // Drop copies of `clip` at the slot under the cursor (anchored to the group's
      // earliest event). Returns false if the cursor isn't over the grid.
      const pasteAtCursor = (clip: PlannerEvent[]): boolean => {
        const mp = mousePosRef.current;
        if (!mp) return false;
        const coords = getGridCoords(mp.x, mp.y);
        const el = daysGridRef.current;
        if (!coords || !el) return false;
        const rect = el.getBoundingClientRect();
        if (!(mp.x >= rect.left && mp.x <= rect.right && mp.y >= rect.top + topBandsHeight && mp.y <= rect.bottom)) {
          return false;
        }

        // Anchor = earliest (top-left) event so relative layout is preserved.
        let anchor = clip[0];
        let minDay = anchor.dayIndex;
        let minStart = timeToMin(anchor.startTime);
        for (const ev of clip) {
          const start = timeToMin(ev.startTime);
          if (ev.dayIndex < minDay || (ev.dayIndex === minDay && start < minStart)) {
            anchor = ev; minDay = ev.dayIndex; minStart = start;
          }
        }

        const wk = editCtxRef.current.viewedWeekKey;
        const stampedNew: PlannerData = {};
        const pastedIds: string[] = [];
        for (const ev of clip) {
          const newId = uid();
          const evStart = timeToMin(ev.startTime);
          const duration = timeToMin(ev.endTime) - evStart;
          const dayOffset = ev.dayIndex - anchor.dayIndex;
          const timeOffset = evStart - timeToMin(anchor.startTime);
          // Clamp into the VISIBLE window — in the custom view that runs past the
          // anchor week on either side.
          const visCols = visibleColsRef.current;
          const targetDay = clamp(coords.dayIndex + dayOffset, visCols[0], visCols[visCols.length - 1]);
          const targetStart = clamp(coords.snappedMin + timeOffset, dayStartRef.current * 60, dayEndRef.current * 60 - duration);
          // A pasted copy is a fresh, standalone item: strip recurrence + Google
          // identity so it never mutates the source's series or sync record.
          stampedNew[newId] = stampNewItem({
            ...ev, id: newId, dayIndex: targetDay,
            startTime: minToTime(targetStart), endTime: minToTime(targetStart + duration),
            recur: undefined, exdates: undefined, masterId: undefined, occDate: undefined,
            gCalId: undefined, gCalCalendarId: undefined, gCalETag: undefined, gCalRecurSig: undefined, lastSyncedAt: undefined, deleted: undefined,
          } as PlannerEvent, wk, editCtxRef.current.weekStartsOn);
          pastedIds.push(newId);
        }
        writeEvents({ ...eventsRef.current, ...stampedNew });
        setSelectedIds(new Set(pastedIds)); // highlight the clone(s); no forced edit
        return true;
      };

      // Resolve the "source" item(s) for a copy: explicit selection wins, then the
      // item under the cursor, then the open menu / the item being edited.
      const resolveSource = (): PlannerEvent[] => {
        let ids: string[] = [];
        if (selectedIdsRef.current.size > 0) ids = Array.from(selectedIdsRef.current);
        else if (hoveredIdRef.current) ids = [hoveredIdRef.current];
        else if (menuIdRef.current) ids = [menuIdRef.current];
        else if (editingIdRef.current) ids = [editingIdRef.current];
        // Resolve against the visible week map first (handles repeating occurrence
        // ids like "master::date"), falling back to the raw store.
        return ids
          .map(id => weekEventsRef.current[id] ?? eventsRef.current[id])
          .filter((ev): ev is PlannerEvent => !!ev);
      };

      // Copy to the app clipboard only. Pasting happens on the paste binding.
      if (hit('copy') && !inTextField) {
        const source = resolveSource();
        if (source.length === 0) return;
        setClipboard(source);
        e.preventDefault();
        return;
      }

      // Paste at the cursor, or fall back to an in-place offset copy.
      if (hit('paste') && !inTextField) {
        const clip = clipboardRef.current;
        if (!clip || clip.length === 0) return;
        if (!pasteAtCursor(clip)) {
          // Not over the grid â†’ drop copies near the originals (+10 min).
          const wk = editCtxRef.current.viewedWeekKey;
          const stampedNew: PlannerData = {};
          const pastedIds: string[] = [];
          for (const ev of clip) {
            const newId = uid();
            const evStart = timeToMin(ev.startTime);
            const duration = timeToMin(ev.endTime) - evStart;
            const pasteStart = clamp(evStart + 10, dayStartRef.current * 60, dayEndRef.current * 60 - duration);
            stampedNew[newId] = stampNewItem({
              ...ev, id: newId,
              startTime: minToTime(pasteStart), endTime: minToTime(pasteStart + duration),
              recur: undefined, exdates: undefined, masterId: undefined, occDate: undefined,
              gCalId: undefined, gCalCalendarId: undefined, gCalETag: undefined, gCalRecurSig: undefined, lastSyncedAt: undefined, deleted: undefined,
            } as PlannerEvent, wk, editCtxRef.current.weekStartsOn);
            pastedIds.push(newId);
          }
          writeEvents({ ...eventsRef.current, ...stampedNew });
          setSelectedIds(new Set(pastedIds));
        }
        e.preventDefault();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [getGridCoords, topBandsHeight]);

  // â”€â”€ Global mouse move / up â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      autoScrollLastPosRef.current = { clientX: e.clientX, clientY: e.clientY };
      const dr = dragRef.current;
      const rr = resizeRef.current;
      const br = batchDragRef.current;
      const sr = selDragRef.current;
      const cr = createDragRef.current;

      const isDragging = (dr && dr.active) || (br && br.active) || rr || sr || (cr && cr.moved);
      if (isDragging) {
        // The page scrolls on the window (root is min-h-screen), so `main` itself
        // usually isn't the scroller — pick whichever element actually overflows.
        const getScroller = (): HTMLElement =>
          (mainRef.current && mainRef.current.scrollHeight > mainRef.current.clientHeight + 1)
            ? mainRef.current
            : ((document.scrollingElement as HTMLElement) || document.documentElement);
        const EDGE = 110;
        const vh = window.innerHeight;
        const nearTop = e.clientY < EDGE;
        const nearBottom = e.clientY > vh - EDGE;
        if (nearTop || nearBottom) {
          if (!autoScrollTimerRef.current) {
            autoScrollTimerRef.current = window.setInterval(() => {
              if (!autoScrollLastPosRef.current) return;
              const { clientX, clientY } = autoScrollLastPosRef.current;
              const h = window.innerHeight;
              let dy = 0;
              // Ramp speed toward the edge, with a floor so it always moves.
              if (clientY < EDGE) dy = -Math.max(6, 22 * (1 - Math.max(0, clientY) / EDGE));
              else if (clientY > h - EDGE) dy = Math.max(6, 22 * (1 - Math.max(0, h - clientY) / EDGE));

              if (dy !== 0) {
                const el = getScroller();
                const before = el.scrollTop;
                el.scrollTop += dy;
                // Re-run the drag math at the (unchanged) cursor so the item keeps
                // following as the grid scrolls beneath it.
                if (el.scrollTop !== before) {
                  const fakeEvent = { clientX, clientY, preventDefault: () => {} } as any as MouseEvent;
                  // Apply the position update synchronously in this same frame so the
                  // item doesn't visually lag a render behind the instant DOM scroll.
                  flushSync(() => onMove(fakeEvent));
                }
              }
            }, 16);
          }
        } else if (autoScrollTimerRef.current) {
          clearInterval(autoScrollTimerRef.current);
          autoScrollTimerRef.current = null;
        }
      }

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
        const rawDelta = clamp(snapMin(coords.snappedMin - br.baseMouseMin, POSITION_SNAP), -dayStartMin * 4, dayEndMin);

        // ONE delta for the whole set, clamped so that every member stays in
        // range — clamping each item separately let the one that hit the edge
        // stop while the others kept going, which silently pulled a linked pair
        // (or a multi-selection) apart. Relative spacing is the whole point of
        // both features, so the group moves as far as its most constrained
        // member allows, and no further.
        //
        // The upper bound deliberately does NOT subtract the item's duration:
        // an item may legitimately run past the end of the visible window (the
        // head/tail rendering handles that), and subtracting it teleported any
        // long overnight block to the bottom of the grid.
        let minDelta = -Infinity;
        let maxDelta = Infinity;
        let minDayDelta = -Infinity;
        let maxDayDelta = Infinity;
        for (const id of br.eventIds) {
          const base = br.baseStartMins[id];
          minDelta = Math.max(minDelta, dayStartMin - base);
          maxDelta = Math.min(maxDelta, (dayEndMin - POSITION_SNAP) - base);
          minDayDelta = Math.max(minDayDelta, 0 - br.baseDays[id]);
          maxDayDelta = Math.min(maxDayDelta, 6 - br.baseDays[id]);
        }
        const deltaMin = clamp(rawDelta, minDelta, maxDelta);
        const dayShift = clamp(dayDelta, minDayDelta, maxDayDelta);

        const newBatchDisp: { [id: string]: { dayIndex: number; startMin: number } } = {};
        for (const id of br.eventIds) {
          newBatchDisp[id] = {
            dayIndex: br.baseDays[id] + dayShift,
            startMin: br.baseStartMins[id] + deltaMin,
          };
        }
        setBatchDisp(newBatchDisp);
        batchDispRef.current = newBatchDisp;
        setDragDelta({ x: e.clientX - br.initX, y: e.clientY - br.initY });
        return;
      }

      // Rubber-band selection (Ctrl+drag on empty column area)
      if (sr) {
        const rect = daysGridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const curX = e.clientX - rect.left;
        const curY = e.clientY - rect.top - topBandsHeight;
        const left = Math.min(sr.startX, curX);
        const top = Math.min(sr.startY, curY);
        const width = Math.abs(curX - sr.startX);
        const height = Math.abs(curY - sr.startY);
        setSelRect({ left, top, width, height });
        e.preventDefault();
        return;
      }

      // Drag-to-create on empty column area (plain left drag)
      if (cr) {
        const rect = daysGridRef.current?.getBoundingClientRect();
        if (!rect) return;
        const curY = e.clientY - rect.top - topBandsHeight;
        const topPx = Math.min(cr.startY, curY);
        const heightPx = Math.abs(curY - cr.startY);
        if (heightPx >= DRAG_THRESHOLD) { cr.moved = true; didDragRef.current = true; }
        if (cr.moved) {
          // Position against the VISIBLE slot, not the week dayIndex (day view).
          const cols = visibleColsRef.current;
          const colW = rect.width / cols.length;
          const slot = Math.max(0, cols.indexOf(cr.col));
          setSelRect({ left: slot * colW + 4, top: topPx, width: colW - 8, height: heightPx });
          // Mirror the exact snapping the commit will use, so the numbers shown
          // during the drag are the ones the item actually gets.
          let s = yToMin(Math.max(0, Math.min(cr.startY, curY)), interval, dayStartH);
          let en = yToMin(Math.max(0, Math.max(cr.startY, curY)), interval, dayStartH);
          s  = clamp(s, dayStartMin, dayEndMin - POSITION_SNAP);
          en = clamp(en, s + POSITION_SNAP, dayEndMin);
          setCreateDisp({ startMin: s, endMin: en });
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
        let targetDay = coords.dayIndex;
        let rawStart = coords.snappedMin - dr.offsetMin;
        if (dr.isHeadClick) {
          targetDay = coords.dayIndex - 1;
          rawStart = coords.snappedMin + 1440 - dr.offsetMin;
        }
        const maxStart = dayEndMin - POSITION_SNAP;
        const newStart = clamp(snapMin(rawStart, POSITION_SNAP), dayStartMin, maxStart);
        dr.curDay = targetDay; dr.curStartMin = newStart;
        setDragDisp({ id: dr.eventId, day: targetDay, startMin: newStart });
        setDragDelta({ x: e.clientX - dr.initX, y: e.clientY - dr.initY });
      }
      if (rr) {
        const coords = getGridCoords(e.clientX, e.clientY);
        if (!coords) return;
        if (rr.edge === 'bottom') {
          let targetEnd = coords.snappedMin;
          if (rr.isHeadClick || coords.dayIndex === ((weekEventsRef.current[rr.eventId] ?? eventsRef.current[rr.eventId])?.dayIndex ?? 0) + 1) {
            targetEnd = coords.snappedMin + 1440;
          }
          const minEnd = rr.startMin + POSITION_SNAP;
          const maxEnd = rr.startMin + 1440;
          const newEnd = clamp(snapMin(targetEnd, POSITION_SNAP), minEnd, maxEnd);
          rr.endMin = newEnd;
          setResizeDisp({ id: rr.eventId, startMin: rr.startMin, endMin: newEnd });
        } else {
          let targetStart = coords.snappedMin;
          if (rr.isHeadClick) {
            targetStart = coords.snappedMin + 1440;
          }
          const minStart = dayStartMin;
          const maxStart = rr.endMin - POSITION_SNAP;
          const newStart = clamp(snapMin(targetStart, POSITION_SNAP), minStart, maxStart);
          rr.startMin = newStart;
          setResizeDisp({ id: rr.eventId, startMin: newStart, endMin: rr.endMin });

          // Preview the train following the start edge. Reusing batchDisp means
          // the existing renderer draws the partners at their new spots for free.
          const partnerIds = Object.keys(rr.linkBase || {});
          if (partnerIds.length) {
            const delta = newStart - rr.baseStartMin;
            const disp: { [id: string]: { dayIndex: number; startMin: number } } = {};
            for (const pid of partnerIds) {
              const base = rr.linkBase[pid];
              disp[pid] = {
                dayIndex: base.dayIndex,
                startMin: clamp(base.startMin + delta, dayStartMin, dayEndMin - POSITION_SNAP),
              };
            }
            setBatchDisp(disp);
            batchDispRef.current = disp;
          }
        }
      }
    };
    const onUp = (e: MouseEvent) => {
      if (autoScrollTimerRef.current) {
        clearInterval(autoScrollTimerRef.current);
        autoScrollTimerRef.current = null;
      }
      const dr = dragRef.current;
      const rr = resizeRef.current;
      const br = batchDragRef.current;
      const sr = selDragRef.current;
      const cr = createDragRef.current;

      setDragDelta(null);

      // Drag-to-create commit (plain left drag on empty area)
      if (cr) {
        createDragRef.current = null;
        setSelRect(null);
        setCreateDisp(null);
        if (cr.moved) {
          const rect = daysGridRef.current?.getBoundingClientRect();
          if (rect) {
            const curY = e.clientY - rect.top - topBandsHeight;
            let startMin = yToMin(Math.max(0, Math.min(cr.startY, curY)), interval, dayStartH);
            let endMin   = yToMin(Math.max(0, Math.max(cr.startY, curY)), interval, dayStartH);
            startMin = clamp(startMin, dayStartMin, dayEndMin - POSITION_SNAP);
            endMin   = clamp(endMin, startMin + POSITION_SNAP, dayEndMin);
            const id = uid();
            createStampedRef.current(
              { id, dayIndex: cr.col, startTime: minToTime(startMin), endTime: minToTime(endMin), content: '', color: 'sage' },
              { edit: true, menuAt: { x: e.clientX + 10, y: e.clientY } },
            );
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
            const patches: Record<string, Partial<PlannerEvent>> = {};
            for (const id of br.eventIds) {
              const bd = finalBatch[id];
              const ev = weekEventsRef.current[id] ?? eventsRef.current[id];
              if (!ev || !bd) continue;
              const dur = br.durations[id] ?? timeToMin(ev.endTime) - timeToMin(ev.startTime);
              patches[id] = { dayIndex: bd.dayIndex, startTime: minToTime(bd.startMin), endTime: minToTime(bd.startMin + dur) };
            }
            applyEditMany(patches);
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
          const cols = visibleColsRef.current;
          const colW = gridRect.width / cols.length;
          const curX = e.clientX - gridRect.left;
          const curY = e.clientY - gridRect.top - topBandsHeight;
          const left = Math.min(sr.startX, curX);
          const right = Math.max(sr.startX, curX);
          const topPx = Math.min(sr.startY, curY);
          const bottomPx = Math.max(sr.startY, curY);
          const topMin = yToMin(Math.max(0, topPx), interval, dayStartH);
          const bottomMin = yToMin(Math.max(0, bottomPx), interval, dayStartH);
          const idsToAdd: string[] = [];
          for (const [id, ev] of Object.entries(weekEventsRef.current)) {
            // Position by VISIBLE slot — day/custom views don't show every dayIndex.
            const slot = cols.indexOf(ev.dayIndex);
            if (slot === -1) continue;
            const colLeft = slot * colW;
            const colRight = (slot + 1) * colW;
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
          const ev = weekEventsRef.current[dr.eventId] ?? eventsRef.current[dr.eventId];
          if (ev) {
            const start24 = dr.curStartMin >= 1440 ? dr.curStartMin - 1440 : dr.curStartMin;
            const end24 = (start24 + dr.durationMin) % 1440;
            applyEditRef.current(dr.eventId, {
              dayIndex: dr.curDay,
              startTime: minToTime(start24),
              endTime: minToTime(end24)
            });
          }
          setTimeout(() => { didDragRef.current = false; }, 80);
        } else { didDragRef.current = false; }
        dragRef.current = null; setDragDisp(null);
      }
      if (rr) {
        const ev = weekEventsRef.current[rr.eventId] ?? eventsRef.current[rr.eventId];
        const partnerIds = Object.keys(rr.linkBase || {});
        const delta = rr.startMin - rr.baseStartMin;
        if (ev) {
          // One batched write for the item and its train, so the whole move is a
          // single undo step rather than one per carriage.
          if (partnerIds.length && delta !== 0) {
            const patches: Record<string, Partial<PlannerEvent>> = {
              [rr.eventId]: { startTime: minToTime(rr.startMin), endTime: minToTime(rr.endMin) },
            };
            for (const pid of partnerIds) {
              const base = rr.linkBase[pid];
              const start = clamp(base.startMin + delta, dayStartMin, dayEndMin - POSITION_SNAP);
              patches[pid] = {
                startTime: minToTime(start >= 1440 ? start - 1440 : start),
                endTime: minToTime((start + base.durationMin) % 1440),
              };
            }
            applyEditManyRef.current(patches);
          } else {
            applyEditRef.current(rr.eventId, { startTime: minToTime(rr.startMin), endTime: minToTime(rr.endMin) });
          }
        }
        resizeRef.current = null; setResizeDisp(null);
        if (partnerIds.length) { setBatchDisp(null); batchDispRef.current = null; }
        setTimeout(() => { didDragRef.current = false; }, 80);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [getGridCoords, interval, dayStartMin, dayEndMin]);

  // Clear multi-selection when clicking/pressing on empty space anywhere
  useEffect(() => {
    if (selectedIds.size === 0) return;
    const onGlobalMouseDown = (e: MouseEvent) => {
      if (e.ctrlKey || e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-event]') || target.closest('[data-menu]') || target.closest('input, textarea, button, select, [role="dialog"]')) return;
      setSelectedIds(new Set());
    };
    window.addEventListener('mousedown', onGlobalMouseDown, true);
    return () => window.removeEventListener('mousedown', onGlobalMouseDown, true);
  }, [selectedIds.size]);

  // Dismiss the task popover on an outside click or Escape.
  useEffect(() => {
    if (!taskMenuId) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t?.closest('[data-menu]') || t?.closest('[data-task]')) return;
      setTaskMenuId(null);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setTaskMenuId(null); };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [taskMenuId]);

  // â”€â”€ Event CRUD helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const handleColClick = (e: React.MouseEvent<HTMLDivElement>, dayIdx: number) => {
    if (didDragRef.current) return;
    if ((e.target as HTMLElement).closest('[data-event]') || (e.target as HTMLElement).closest('[data-task]')) return;
    if (e.ctrlKey || e.metaKey) return; // Ctrl+click â†’ rubber band handled in onMouseDown
    setSelectedIds(new Set());
    const rect     = e.currentTarget.getBoundingClientRect();
    const startMin = clamp(yToMin(Math.max(0, e.clientY - rect.top), interval, dayStartH), dayStartMin, dayEndMin - DEFAULT_EVENT_MIN);
    const dur      = Math.min(DEFAULT_EVENT_MIN, dayEndMin - startMin);
    const id       = uid();
    createStamped(
      { id, dayIndex: dayIdx, startTime: minToTime(startMin), endTime: minToTime(startMin + dur), content: '', color: 'sage' },
      { edit: true, menuAt: { x: e.clientX + 10, y: e.clientY } },
    );
  };

  const handleEventMouseDown = (e: React.MouseEvent, ev: PlannerEvent, segKind?: 'normal' | 'tail' | 'head') => {
    if (editingId === ev.id) return;
    e.preventDefault(); e.stopPropagation();
    if (e.ctrlKey || e.metaKey) return; // toggle selection in onClick, don't drag

    // Batch drag: mousedown on a selected event while others are selected — or on
    // a LINKED item, whose whole train moves as one whether it's selected or not.
    const linkedIds = linkedIdsOf(ev, ev.id);
    const dragIds: string[] =
      selectedIds.size > 1 && selectedIds.has(ev.id) ? [...selectedIds]
      : linkedIds.length > 1 ? linkedIds
      : [];
    if (dragIds.length > 1) {
      const coords = getGridCoords(e.clientX, e.clientY);
      if (!coords) return;
      const baseStartMins: Record<string, number> = {};
      const baseDays: Record<string, number> = {};
      const durations: Record<string, number> = {};
      for (const id of dragIds) {
        const eRef = weekEventsRef.current[id] ?? eventsRef.current[id];
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
        eventIds: dragIds, baseStartMins, baseDays, durations,
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

    const isHead = segKind === 'head';
    let offsetMin = clamp(coords.snappedMin - startMin, 0, duration);
    if (isHead) {
      offsetMin = clamp(coords.snappedMin + 1440 - startMin, 0, duration);
    }

    dragRef.current = {
      eventId: ev.id, durationMin: duration,
      offsetMin,
      isHeadClick: isHead,
      origDay: ev.dayIndex, curDay: ev.dayIndex, curStartMin: startMin,
      active: false, initX: e.clientX, initY: e.clientY,
    };
  };

  const handleResizeMouseDown = (e: React.MouseEvent, ev: PlannerEvent, edge: 'top' | 'bottom', segKind?: 'normal' | 'tail' | 'head') => {
    e.preventDefault(); e.stopPropagation();
    const startMin = normalizeMin(timeToMin(ev.startTime), dayStartH);
    let endMin     = normalizeMin(timeToMin(ev.endTime), dayStartH);
    if (endMin <= startMin) endMin += 1440;
    // Dragging the START edge carries the linked train with it (the whole point
    // of linking "Get Up" to "Sleeping"): remember where every partner sat so the
    // move can be replayed as a delta. The END edge moves nothing — growing an
    // item downward doesn't reposition what precedes it.
    const linkBase: Record<string, { dayIndex: number; startMin: number; durationMin: number }> = {};
    if (edge === 'top') {
      for (const partnerId of linkedIdsOf(ev, ev.id)) {
        if (partnerId === ev.id) continue;
        const partner = weekEventsRef.current[partnerId] ?? eventsRef.current[partnerId];
        if (!partner) continue;
        const ps = normalizeMin(timeToMin(partner.startTime), dayStartH);
        let pe = normalizeMin(timeToMin(partner.endTime), dayStartH);
        if (pe <= ps) pe += 1440;
        linkBase[partnerId] = { dayIndex: partner.dayIndex, startMin: ps, durationMin: pe - ps };
      }
    }
    resizeRef.current = {
      eventId: ev.id, edge, startMin, endMin,
      isHeadClick: segKind === 'head',
      isTailClick: segKind === 'tail',
      baseStartMin: startMin,
      linkBase,
    };
    // Mark this as a drag gesture: releasing over empty grid must not be read as a
    // click that creates a new item there (cleared shortly after mouseup).
    didDragRef.current = true;
  };

  const openMenu = (e: React.MouseEvent, ev: PlannerEvent) => {
    e.stopPropagation();
    if (didDragRef.current) return;
    // Position popover to the right of the event block; fall back to left if near right edge
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x    = rect.right + 6;
    const y    = rect.top;
    setMenuPinned(false);       // anchor to this event (until the user drags it)
    setMenuId(ev.id);
    setMenuPos({ x, y });
  };

  const toggleEventCompleted = (id: string, day: Date) => {
    const dateStr = format(day, 'yyyy-MM-dd');
    // `id` may be an occurrence id ("master::date"); completion is tracked on the
    // stored master's completedDates, so resolve to the master before mutating.
    const { masterId } = parseOccId(id);
    const prev = eventsRef.current;
    const ev = prev[masterId];
    if (!ev) return;
    const completedDates = ev.completedDates || [];
    const updatedDates = completedDates.includes(dateStr)
      ? completedDates.filter(d => d !== dateStr)
      : [...completedDates, dateStr];
    const updatedEvents = { ...prev, [masterId]: { ...ev, completedDates: updatedDates } };
    writeEvents(updatedEvents);
    fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updatedEvents),
    }).catch(err => console.error("Failed to save checkbox state:", err));
  };

  const deleteEvent = (id: string) => {
    applyDelete(id);
    if (editingId === id) setEditingId(null);
    setMenuId(null); setMenuPos(null);
  };

  const cloneAcrossWeek = (ev: PlannerEvent) => {
    const wk = editCtxRef.current.viewedWeekKey;
    const additions: PlannerData = {};
    for (let day = 0; day < 7; day++) {
      if (day === ev.dayIndex) continue;
      const newId = uid();
      // Each clone is a fresh, non-repeating copy on that day (recurrence + sync
      // identity stripped so it stands alone).
      additions[newId] = stampNewItem({ ...ev, id: newId, dayIndex: day, weekKey: wk, recur: undefined, exdates: undefined, masterId: undefined, occDate: undefined, gCalId: undefined, gCalCalendarId: undefined, gCalETag: undefined, gCalRecurSig: undefined, lastSyncedAt: undefined, deleted: undefined }, wk, weekStartsOn);
    }
    writeEvents({ ...eventsRef.current, ...additions });
    setMenuId(null); setMenuPos(null);
  };

  // â”€â”€ Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const goBack  = () => { setDirection(-1); setCurrentDate(d => subWeeks(d, 1)); setEditingId(null); setMenuId(null); };
  const goNext  = () => { setDirection(1);  setCurrentDate(d => addWeeks(d, 1));  setEditingId(null); setMenuId(null); };
  const goToday = () => { setDirection(0);  setCurrentDate(nowOwnerDate);          setEditingId(null); setMenuId(null); };
  // View-aware prev/next: one unit of whatever is currently on screen.
  const navStep = (dir: -1 | 1) => {
    setDirection(dir);
    setCurrentDate(d => {
      switch (calendarView) {
        case 'day':   return addDays(d, dir);
        // The custom window is anchored to the week start, so stepping moves a whole
        // week — the window keeps the same shape (e.g. Sat → next Sat) as it walks.
        case 'custom': return dir < 0 ? subWeeks(d, 1) : addWeeks(d, 1);
        case 'month': return dir < 0 ? subMonths(d, 1) : addMonths(d, 1);
        case 'year':  return dir < 0 ? subMonths(d, 12) : addMonths(d, 12);
        default:      return dir < 0 ? subWeeks(d, 1) : addWeeks(d, 1);
      }
    });
    setEditingId(null);
    setMenuId(null);
  };
  // On the analysis screen the same prev/next gesture walks that screen's own
  // cursor — one week, month or year depending on the active tab.
  const analysisStep = (dir: -1 | 1) => {
    if (analysisTab === 'week')       setAnalysisWeekCursor(d => (dir < 0 ? subWeeks(d, 1) : addWeeks(d, 1)));
    else if (analysisTab === 'month') setAnalysisMonthCursor(d => (dir < 0 ? subMonths(d, 1) : addMonths(d, 1)));
    else                              setAnalysisYearCursor(y => y + dir);
  };
  const navPrev = () => (showFocusAnalysis ? analysisStep(-1) : navStep(-1));
  const navNext = () => (showFocusAnalysis ? analysisStep(1)  : navStep(1));

  // Ctrl+wheel steps along day â†’ week â†’ month â†’ year (or week â†’ month â†’ year on analysis screen).
  const stepCalendarZoom = useCallback((dir: -1 | 1) => {
    setDirection(0);
    setEditingId(null);
    setMenuId(null);
    if (showFocusAnalysis) {
      const tabs = ['week', 'month', 'year'] as const;
      setAnalysisTab(t => {
        const i = tabs.indexOf(t);
        return tabs[clamp(i + dir, 0, tabs.length - 1)];
      });
    } else {
      setCalendarView(v => {
        const i = CALENDAR_VIEWS.indexOf(v);
        return CALENDAR_VIEWS[clamp(i + dir, 0, CALENDAR_VIEWS.length - 1)];
      });
    }
  }, [showFocusAnalysis]);

  // Keep the shortcut runner pointed at the current closures.
  navRef.current = {
    prev: navPrev,
    next: navNext,
    today: () => {
      if (showFocusAnalysis) {
        setAnalysisWeekCursor(new Date());
        setAnalysisMonthCursor(new Date());
        setAnalysisYearCursor(new Date().getFullYear());
        return;
      }
      goToday();
    },
    goToLive: () => { setShowFocusAnalysis(false); setCalendarView('week'); scrollToLive(); },
    toggleView: () => {
      setDirection(0);
      if (showFocusAnalysis) {
        setAnalysisTab(t => (t === 'week' ? 'month' : 'week'));
      } else {
        setCalendarView(v => (v === 'week' ? 'month' : 'week'));
      }
    },
    toggleAnalysis: () => setShowFocusAnalysis(v => !v),
    toggleSettings: () => navigateToSettings(),
    openWidget: () => openWidget(),
    newEvent: () => { setShowFocusAnalysis(false); handleHeaderCreateClick(); },
    toggleTimer: () => { if (focusTimer.isRunning) pauseFocus(); else startFocus(); },
    toggleHelp: () => setShowShortcutHelp(v => !v),
  };

  // â”€â”€ Ctrl+wheel = calendar zoom, Ctrl +/âˆ’ = app zoom â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Both replace the browser's own page zoom, which is why every branch calls
  // preventDefault. Listeners are non-passive so preventDefault actually applies.
  const stepZoomRef = useRef(stepCalendarZoom);
  useEffect(() => { stepZoomRef.current = stepCalendarZoom; }, [stepCalendarZoom]);

  useEffect(() => {
    const wheelCooldown = { t: 0 };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault(); // kill the browser's pinch/ctrl zoom
      // Trackpads emit a burst of small deltas per gesture — throttle so one
      // gesture moves exactly one level.
      const now = Date.now();
      if (now - wheelCooldown.t < 90) return;
      if (Math.abs(e.deltaY) < 1) return;
      wheelCooldown.t = now;
      // Scroll up = zoom IN (toward a single day), down = out (toward the year).
      stepZoomRef.current(e.deltaY < 0 ? -1 : 1);
    };
    const onKeyZoom = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // '=' carries the unshifted '+' on most layouts; NumpadAdd reports '+'.
      if (e.key === '+' || e.key === '=' || e.key === 'Add') {
        e.preventDefault();
        setAppZoom(z => clampZoom(z + ZOOM_STEP));
      } else if (e.key === '-' || e.key === '_' || e.key === 'Subtract') {
        e.preventDefault();
        setAppZoom(z => clampZoom(z - ZOOM_STEP));
      } else if (e.key === '0') {
        e.preventDefault();
        setAppZoom(1);
      }
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKeyZoom);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyZoom);
    };
  }, []);

  // Persist zoom, and keep the editable field in sync when it changes elsewhere.
  useEffect(() => {
    localStorage.setItem(ZOOM_KEY, String(appZoom));
    if (!editingZoom) setZoomDraft(String(Math.round(appZoom * 100)));
  }, [appZoom, editingZoom]);

  // Sync dark mode class with document root
  useEffect(() => {
    if (darkMode) document.documentElement.classList.add('dark');
    else document.documentElement.classList.remove('dark');
  }, [darkMode]);

  const commitZoomDraft = () => {
    const pct = parseInt(zoomDraft, 10);
    if (Number.isFinite(pct) && pct > 0) setAppZoom(clampZoom(pct / 100));
    else setZoomDraft(String(Math.round(appZoom * 100)));
    setEditingZoom(false);
  };

  // â”€â”€ Display props (override during drag/resize/batch) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // Anything that means "the user is in the middle of something" — a pushed
  // database change must wait rather than yank state out from under them.
  uiBusyRef.current = !!editingId || !!menuId || isDraggingAnything || isResizingAnything || !!draft;

  // Background themes live in settingsSync so the main window, the side window and
  // the settings pickers all paint from one definition.
  const currentDarkTheme  = themePalette(true, darkPreset, lightPreset);
  const currentLightTheme = themePalette(false, darkPreset, lightPreset);

  const surfaceBg  = darkMode ? currentDarkTheme.surfaceBg : currentLightTheme.surfaceBg;
  const surfaceBdr = darkMode ? currentDarkTheme.surfaceBdr : currentLightTheme.surfaceBdr;
  const hoverBg    = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)';
  const menuBg     = darkMode ? currentDarkTheme.cardBg : currentLightTheme.cardBg;
  const menuBdr    = darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)';
  const menuText   = darkMode ? '#e8e8e8' : '#0f172a';
  const menuSub    = darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(15,23,42,0.55)';
  // Header control text — brighter than muted-foreground so it isn't washed out in dark mode.
  const headerLabel    = darkMode ? 'rgba(255,255,255,0.62)' : '#475569';
  const headerInactive = darkMode ? 'rgba(255,255,255,0.72)' : '#334155';
  // Now-line accent: a warmer, less harsh red on dark, a deeper one on light.
  const nowAccent     = darkMode ? '#ff6b6b' : '#e5484d';
  const nowAccentSoft = darkMode ? 'rgba(255,107,107,0.22)' : 'rgba(229,72,77,0.18)';

  // Everything the tasks panel and popover need to paint, bundled once so they
  // stay in step with the calendar's theme without importing the palettes.
  const taskPanelTheme: TaskTheme = {
    darkMode, menuText, menuSub, menuBg, menuBdr, surfaceBg, surfaceBdr, hoverBg,
    accent: taskColor,
    chip: taskChipColors,
  };

  // The task the popover is editing. Occurrence ids ("master::date") aren't in the
  // raw store, so resolve through the week expansion first — same rule as events.
  const menuTask = taskMenuId
    ? (weekTasks[taskMenuId] ?? tasks[taskMenuId] ?? tasks[parseOccId(taskMenuId).masterId] ?? null)
    : null;
  const menuTaskDue = menuTask ? dueDateOf(menuTask) : null;
  const menuTaskKind = menuTask ? taskKind(menuTask) : 'general';
  const menuTaskDone = menuTask ? isTaskDone(menuTask, menuTaskDue) : false;

  // â”€â”€ Current menu event (for popover rendering) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const isDraft = !!(draft && menuId === draft.id);
  const menuEvent = isDraft
    ? draft
    : (menuId ? (weekEvents[menuId] ?? events[menuId] ?? events[parseOccId(menuId).masterId] ?? null) : null);

  // Commit the draft into the real event map (Save). Closing the popup afterwards
  // clears the draft via the menuId-null effect.
  const commitDraft = () => {
    if (!draftRef.current) return;
    const d = { ...draftRef.current, updatedAt: Date.now() };
    writeEvents({ ...eventsRef.current, [d.id]: d });
    setDraft(null);
    setMenuId(null);
    setMenuPos(null);
  };

  // â”€â”€â”€ Render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return (
    <div
      className={`h-screen min-h-screen flex flex-col font-sans select-none transition-colors duration-300 relative overflow-hidden ${
        darkMode ? 'dark text-[#f1f5f9]' : 'text-[#0f172a]'
      }`}
      style={{ cursor: globalCursor, zoom: appZoom, background: darkMode ? currentDarkTheme.rootBg : currentLightTheme.rootBg }}
    >
      {/* â”€â”€ Outer Side Ambient Glow Layer (Zero Banding & Non-interfering) â”€â”€ */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
        {/* Soft Side Ambient Aura - Left */}
        <div
          className={`absolute -top-32 -left-32 w-[600px] h-[600px] rounded-full blur-[160px] pointer-events-none transition-all duration-500 ${
            sidebarStyle === 'minimal-flat' ? 'opacity-0' : sidebarStyle === 'accent-aura' ? 'opacity-90' : sidebarStyle === 'glass-translucent' ? 'opacity-35' : 'opacity-50'
          }`}
          style={{
            background: darkMode
              ? 'radial-gradient(circle, rgba(59,130,246,0.18) 0%, rgba(99,102,241,0.06) 65%, transparent 100%)'
              : 'radial-gradient(circle, rgba(99,102,241,0.10) 0%, rgba(192,132,252,0.04) 65%, transparent 100%)',
          }}
        />
        {/* Soft Side Ambient Aura - Right */}
        <div
          className={`absolute top-1/3 -right-32 w-[600px] h-[600px] rounded-full blur-[160px] pointer-events-none transition-all duration-500 ${
            sidebarStyle === 'minimal-flat' ? 'opacity-0' : sidebarStyle === 'accent-aura' ? 'opacity-80' : sidebarStyle === 'glass-translucent' ? 'opacity-25' : 'opacity-40'
          }`}
          style={{
            background: darkMode
              ? 'radial-gradient(circle, rgba(16,185,129,0.14) 0%, rgba(59,130,246,0.04) 65%, transparent 100%)'
              : 'radial-gradient(circle, rgba(16,185,129,0.08) 0%, rgba(59,130,246,0.03) 65%, transparent 100%)',
          }}
        />
        {/* Fine Micro-Dot Pattern on Outer Flanks */}
        <div
          className="absolute inset-0 opacity-[0.035] dark:opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(${darkMode ? 'rgba(255,255,255,0.8)' : 'rgba(15,23,42,0.8)'} 1px, transparent 1px)`,
            backgroundSize: '28px 28px',
          }}
        />
      </div>
      {/* â”€â”€ Content column + tasks panel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          The tasks panel sits in normal flow beside the content rather than
          overlaying it, so opening it NARROWS the header, the focus banner and
          the grid together (they all centre themselves with `mx-auto` inside
          this column). Keeping it in flow also matters because the root carries
          `zoom: appZoom` — a `position: fixed` panel would be laid out in scaled
          coordinates and drift away from the edge at anything but 100%. */}
      <div className="flex-1 min-h-0 flex relative z-10">
        <div className="flex-1 min-w-0 flex flex-col relative">
      {/* â”€â”€ Header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <header className="sticky top-0 z-30 bg-background/85 backdrop-blur-md border-b border-border/50">
        {/* The toolbar spans the full content width (the grid below stays capped at
            1400 and centred) — capping it too wasted the side margins and forced the
            controls onto a second line. It still wraps if the window gets narrow. */}
        <div className="w-full px-6 min-h-14 py-1.5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
          <div className="flex items-center gap-3.5 flex-shrink-0">
            {showFocusAnalysis ? (
              <button
                onClick={() => setShowFocusAnalysis(false)}
                className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-lg text-sm font-medium transition-colors"
                style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText }}
                onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)}
                onMouseLeave={e=>(e.currentTarget.style.background=surfaceBg)}
                title="Back to calendar"
              >
                <Home size={15}/>
                Home
              </button>
            ) : (
              <>
                <span className="text-base font-semibold tracking-tight text-foreground/80 whitespace-nowrap">
                  {calendarView === 'day'
                    ? format(currentDate, 'EEEE, MMM d yyyy')
                    : calendarView === 'year'
                      ? format(currentDate, 'yyyy')
                      : calendarView === 'custom'
                        ? `${format(dayAt(customFrom), 'MMM d')} – ${format(dayAt(customTo - 1), 'MMM d')}`
                        : format(calendarView === 'month' ? currentDate : weekStart, 'MMMM yyyy')}
                </span>
                {/* Which week of the shown month this is (week view only). */}
                {calendarView === 'week' && (
                  <span
                    className="text-[9.5px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-md whitespace-nowrap -ml-2.5"
                    style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: headerInactive }}
                    title={`Week ${weekOfMonth} of ${format(weekStart, 'MMMM')}`}
                  >
                    Week {weekOfMonth}
                  </span>
                )}
                <div className="flex items-center rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                  <button onClick={navPrev}  title={`Previous ${calendarView} (${formatCombo(shortcuts.prevWeek)})`} className="p-1.5 rounded-md text-muted-foreground transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}><ChevronLeft size={15}/></button>
                  <button onClick={goToday} title={`Jump to today (${formatCombo(shortcuts.today)})`} className="px-3 py-1 text-xs font-medium text-foreground/75 rounded-md transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>Today</button>
                  <button onClick={navNext}  title={`Next ${calendarView} (${formatCombo(shortcuts.nextWeek)})`} className="p-1.5 rounded-md text-muted-foreground transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}><ChevronRight size={15}/></button>
                </div>
                {/* Day / Week / Month / Year / Custom switch (Ctrl+wheel steps the first four) */}
                <div className="flex rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }} title="Ctrl + scroll to zoom between these">
                  {CALENDAR_VIEW_BUTTONS.map(v => {
                    const active = calendarView === v;
                    return (
                      <button key={v} onClick={() => { setDirection(0); setCalendarView(v); }} className="px-2.5 py-1 text-xs font-semibold rounded-md transition-all duration-200 capitalize"
                        style={{ background: active ? (darkMode ? 'rgba(255,255,255,0.14)' : '#fff') : 'transparent', color: active ? (darkMode ? '#f5f5f5' : menuText) : headerInactive, boxShadow: active ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>
                        {v}
                      </button>
                    );
                  })}
                </div>
                {/* Custom window size: P days before the week start, N days from it. */}
                {calendarView === 'custom' && (
                  <div className="flex flex-col rounded-lg px-1 py-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                    {([
                      { label: 'Before', title: `Days shown BEFORE the week start (${format(weekStart, 'EEEE')})`, value: customDaysBefore, min: 0, max: CUSTOM_BEFORE_MAX, set: setCustomDaysBefore },
                      { label: 'After',  title: `Days shown FROM the week start (${format(weekStart, 'EEEE')}) onwards`, value: customDaysAfter, min: CUSTOM_AFTER_MIN, max: CUSTOM_AFTER_MAX, set: setCustomDaysAfter },
                    ] as const).map(s => (
                      <div key={s.label} className="flex items-center h-[19px]" title={s.title}>
                        <span className="text-[8.5px] font-bold uppercase tracking-wider w-[34px]" style={{ color: headerInactive }}>{s.label}</span>
                        <button
                          onClick={() => s.set(v => Math.max(s.min, v - 1))}
                          disabled={s.value <= s.min}
                          className="px-0.5 rounded transition-colors disabled:opacity-30"
                          style={{ color: headerInactive }}
                          onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = hoverBg; }}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        ><Minus size={10}/></button>
                        <span className="w-[15px] text-center text-[10.5px] font-semibold tabular-nums" style={{ color: menuText }}>{s.value}</span>
                        <button
                          onClick={() => s.set(v => Math.min(s.max, v + 1))}
                          disabled={s.value >= s.max}
                          className="px-0.5 rounded transition-colors disabled:opacity-30"
                          style={{ color: headerInactive }}
                          onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = hoverBg; }}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        ><Plus size={10}/></button>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
          <div className="flex items-center gap-2 ml-auto flex-shrink-0">
            <button onClick={() => setDarkMode(d => !d)} title={darkMode ? 'Light mode' : 'Dark mode'} className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              {darkMode ? <Sun size={14}/> : <Moon size={14}/>}
            </button>
            {/* App zoom stepper — mirrors Ctrl +/âˆ’ (Ctrl+0 resets). */}
            <div className="flex items-center rounded-lg shadow-sm overflow-hidden" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }} title="Zoom (Ctrl + / Ctrl − , Ctrl 0 to reset)">
              <button
                onClick={() => setAppZoom(z => clampZoom(z - ZOOM_STEP))}
                disabled={appZoom <= ZOOM_MIN + 1e-9}
                className="px-1 py-1 transition-colors disabled:opacity-30"
                style={{ color: headerInactive }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = hoverBg; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Minus size={12}/>
              </button>
              {editingZoom ? (
                <input
                  autoFocus
                  value={zoomDraft}
                  onChange={e => setZoomDraft(e.target.value.replace(/[^\d]/g, ''))}
                  onBlur={commitZoomDraft}
                  onKeyDown={e => {
                    if (e.key === 'Enter') commitZoomDraft();
                    if (e.key === 'Escape') { setZoomDraft(String(Math.round(appZoom * 100))); setEditingZoom(false); }
                  }}
                  className="w-[34px] bg-transparent outline-none text-center text-[11px] font-semibold tabular-nums"
                  style={{ color: menuText }}
                />
              ) : (
                <button
                  onClick={() => { setZoomDraft(String(Math.round(appZoom * 100))); setEditingZoom(true); }}
                  className="w-[40px] text-[11px] font-semibold tabular-nums cursor-text"
                  style={{ color: menuText }}
                  title="Click to type an exact zoom %"
                >
                  {Math.round(appZoom * 100)}%
                </button>
              )}
              <button
                onClick={() => setAppZoom(z => clampZoom(z + ZOOM_STEP))}
                disabled={appZoom >= ZOOM_MAX - 1e-9}
                className="px-1 py-1 transition-colors disabled:opacity-30"
                style={{ color: headerInactive }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = hoverBg; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Plus size={12}/>
              </button>
            </div>
            {!showFocusAnalysis && isTimelineView && (
              <>
                <div className="flex items-center gap-2" title="Grid interval">
                  <div className="flex rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                    {([5, 15, 30, 60] as IntervalMin[]).map(v => (
                      <button key={v} onClick={() => setIntervalOpt(v)} className="px-2.5 py-1 text-xs font-semibold rounded-md transition-all duration-200"
                        style={{ background: interval===v ? (darkMode?'rgba(255,255,255,0.14)':'#fff') : 'transparent', color: interval===v ? (darkMode ? '#f5f5f5' : menuText) : headerInactive, boxShadow: interval===v ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>
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
                    style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: headerInactive, opacity: undoStack.current.length === 0 ? 0.4 : 1, cursor: undoStack.current.length === 0 ? 'default' : 'pointer' }}
                  >
                    <Undo2 size={14}/>
                  </button>
                  <button
                    onClick={redo}
                    disabled={redoStack.current.length === 0}
                    title="Redo (Ctrl+Shift+Z)"
                    className="p-1.5 rounded-lg transition-colors"
                    style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: headerInactive, opacity: redoStack.current.length === 0 ? 0.4 : 1, cursor: redoStack.current.length === 0 ? 'default' : 'pointer' }}
                  >
                    <Redo2 size={14}/>
                  </button>
                </div>
              </>
            )}
            {/* A dead Google authorisation is a dead end until the user acts, so
                it replaces the sync spinner with something clickable rather than
                hiding behind it. */}
            {gCalStatus.needsReconnect && (
              <button
                onClick={() => navigateToSettings('integrations')}
                title={gCalStatus.authError || 'Google rejected the saved authorisation. Reconnect to resume syncing.'}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition-colors shadow-sm"
                style={{ background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.5)', color: '#f87171' }}
              >
                <AlertTriangle size={12} />
                Google disconnected — reconnect
              </button>
            )}
            {/* Live sync indicator — quiet when idle, spins while syncing. */}
            <AnimatePresence>
              {gCalSyncing && !gCalStatus.needsReconnect && (
                <motion.span
                  key="sync-spinner"
                  initial={{ opacity: 0, width: 0 }}
                  animate={{ opacity: 1, width: 'auto' }}
                  exit={{ opacity: 0, width: 0 }}
                  transition={{ duration: 0.2 }}
                  className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap"
                  title="Syncing with Google Calendar"
                >
                  <motion.span
                    className="inline-block rounded-full flex-shrink-0"
                    style={{ width: 8, height: 8, border: '1.5px solid #60a5fa', borderTopColor: 'transparent' }}
                    animate={{ rotate: 360 }}
                    transition={{ duration: 0.8, repeat: Infinity, ease: 'linear' }}
                  />
                  <span className="text-[10px] font-semibold" style={{ color: '#60a5fa' }}>Syncing</span>
                </motion.span>
              )}
            </AnimatePresence>
            {/* Prayer times for today — collapsed to the next one, expanding to
                the whole day (Sunrise included) on click. */}
            {prayer.enabled && todayPrayerList.length > 0 && (
              <div className="relative" ref={prayerPanelRef}>
                <button
                  onClick={() => setPrayerPanelOpen(v => !v)}
                  title={nextPrayer
                    ? `Next: ${nextPrayer.label} at ${formatTimeLabel(nextPrayer.minutes, timeFormat)} — click for the whole day`
                    : "Today's prayer times"}
                  className="flex items-center gap-1 px-1.5 py-1.5 rounded-lg text-[11px] font-semibold transition-colors shadow-sm"
                  style={{
                    background: prayerPanelOpen ? `${prayer.color}26` : surfaceBg,
                    border: `1px solid ${prayerPanelOpen ? prayer.color : surfaceBdr}`,
                    color: prayerPanelOpen ? prayer.color : headerInactive,
                  }}
                >
                  <Moon size={12} style={{ color: prayer.color }} />
                  {nextPrayer && (
                    <span className="tabular-nums whitespace-nowrap">
                      {formatTimeLabel(nextPrayer.minutes, timeFormat)}
                    </span>
                  )}
                  <ChevronDown
                    size={11}
                    style={{ transform: prayerPanelOpen ? 'rotate(180deg)' : 'none', transition: 'transform 150ms' }}
                  />
                </button>

                <AnimatePresence>
                  {prayerPanelOpen && (
                    <motion.div
                      initial={{ opacity: 0, y: -6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -6 }}
                      transition={{ duration: 0.14, ease: 'easeOut' }}
                      className="absolute right-0 top-full mt-1.5 z-50 rounded-xl border shadow-xl overflow-hidden"
                      style={{ background: menuBg, borderColor: surfaceBdr, minWidth: 216 }}
                    >
                      <div className="px-3 pt-2.5 pb-1.5 flex items-baseline justify-between gap-3">
                        <span className="text-[11px] font-bold" style={{ color: menuText }}>
                          {format(new Date(nowTick), 'EEEE, MMM d')}
                        </span>
                        <span className="text-[10px]" style={{ color: menuSub }}>{prayer.city}</span>
                      </div>
                      <div className="pb-1.5">
                        {todayPrayerList.map(p => {
                          const done = isPrayerDone(p.dateStr, p.key);
                          const isNext = nextPrayer?.key === p.key;
                          const passed = !done && !isNext && nextPrayer !== null && p.minutes < nextPrayer.minutes;
                          return (
                            <button
                              key={p.id}
                              onClick={() => togglePrayerDone(p.dateStr, p.key)}
                              className="w-full px-3 py-1.5 flex items-center gap-2 transition-colors text-left"
                              style={{ background: isNext ? `${prayer.color}1f` : 'transparent' }}
                              onMouseEnter={e => { if (!isNext) e.currentTarget.style.background = hoverBg; }}
                              onMouseLeave={e => { if (!isNext) e.currentTarget.style.background = 'transparent'; }}
                              title={done ? `${p.label} — done` : `Mark ${p.label} as done`}
                            >
                              <span className="flex-shrink-0 flex items-center" style={{ color: prayer.color, opacity: done ? 1 : 0.75 }}>
                                {done ? <CheckCircle2 size={13} /> : <Circle size={13} />}
                              </span>
                              <span
                                className="text-[12px] font-semibold flex-1"
                                style={{
                                  color: isNext ? prayer.color : menuText,
                                  opacity: passed ? 0.5 : 1,
                                  textDecoration: done ? 'line-through' : 'none',
                                }}
                              >
                                {p.label}
                              </span>
                              <span
                                className="text-[12px] font-bold tabular-nums"
                                style={{ color: isNext ? prayer.color : menuText, opacity: passed ? 0.5 : 0.9 }}
                              >
                                {formatTimeLabel(p.minutes, timeFormat)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            )}
            <button
              onClick={() => setShowFocusAnalysis(v => !v)}
              title={`${showFocusAnalysis ? 'Back to calendar' : 'Focus Analysis'} (${formatCombo(shortcuts.focusAnalysis)})`}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold transition-colors shadow-sm"
              style={{
                background: showFocusAnalysis ? (darkMode?'rgba(96,165,250,0.22)':'rgba(37,99,235,0.12)') : surfaceBg,
                border: `1px solid ${showFocusAnalysis ? 'rgba(96,165,250,0.50)' : surfaceBdr}`,
                color: showFocusAnalysis ? '#60a5fa' : menuText,
              }}
            >
              <BarChart3 size={15}/>
              Analysis
            </button>
            <button
              onClick={() => setTasksPanelOpen(v => !v)}
              title={tasksPanelOpen ? 'Hide tasks' : 'Show tasks'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold transition-colors shadow-sm"
              style={{
                background: tasksPanelOpen ? `${taskColor}22` : surfaceBg,
                border: `1px solid ${tasksPanelOpen ? `${taskColor}88` : surfaceBdr}`,
                color: tasksPanelOpen ? taskColor : menuText,
              }}
            >
              <ListTodo size={15}/>
              Tasks
            </button>
            <button
              onClick={handleHeaderCreateClick}
              title="Create Event"
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-blue-500 hover:bg-blue-600 transition-colors shadow-sm cursor-pointer"
            >
              <Plus size={14} />
              Create
            </button>
            <button onClick={openWidget} title="Open Floating Widget" className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              <AppWindow size={14}/>
            </button>
            <button
              onClick={() => setShowShortcutHelp(true)}
              title={`Keyboard shortcuts (${formatCombo(shortcuts.help)})`}
              className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
              style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}
            >
              <Keyboard size={14}/>
            </button>
            <button onClick={() => navigateToSettings()} title="Settings" className="p-1 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              <Settings size={14}/>
            </button>
          </div>
        </div>
      </header>

      {/* â”€â”€ Grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <main
        ref={mainRef}
        className={`flex-1 min-h-0 ${settingsRouteOpen ? 'overflow-hidden' : 'overflow-auto'}`}
        onScroll={handleMainScroll}
      >
        <AnimatePresence mode="wait">
          {!showFocusAnalysis ? (
            <motion.div
              key="calendar-view-container"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.08, ease: 'easeOut' }}
              className="min-w-[900px] max-w-[1400px] mx-auto p-4"
            >
          {isTimelineView && (
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

              <div className="flex-1 min-w-0 flex items-end gap-2 h-20">
                {focusStats.perDay.map(day => {
                  const pct = day.seconds > 0 ? Math.max(5, (day.seconds / focusStats.maxSeconds) * 100) : 0;
                  const active = isSameDay(day.day, nowOwnerDate);
                  return (
                    <div key={day.key} className="flex-1 h-full flex flex-col justify-end gap-1 min-w-0">
                      {/* Exact hours for this day, right above its bar. */}
                      <div
                        className="text-[9px] font-bold tabular-nums text-center truncate leading-none"
                        style={{ color: day.seconds > 0 ? (active ? '#60a5fa' : menuText) : menuSub, opacity: day.seconds > 0 ? 1 : 0.45 }}
                      >
                        {day.seconds > 0 ? formatFocusDuration(day.seconds) : '—'}
                      </div>
                      <div className="flex-1 flex items-end">
                        <div
                          className="w-full rounded-t-md transition-all duration-300"
                          title={`${format(day.day, 'EEEE')}: ${formatFocusDuration(day.seconds)}${day.sessions ? ` · ${day.sessions} session${day.sessions === 1 ? '' : 's'}` : ''}`}
                          style={{
                            height: `${pct}%`,
                            minHeight: day.seconds > 0 ? 3 : 0,
                            background: active ? '#60a5fa' : darkMode ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)',
                            border: `1px solid ${active ? 'rgba(96,165,250,0.70)' : surfaceBdr}`,
                          }}
                        />
                      </div>
                      <div className="text-[9px] font-semibold text-center uppercase truncate leading-none" style={{ color: active ? '#60a5fa' : menuSub }}>
                        {format(day.day, 'EEE')}
                      </div>
                    </div>
                  );
                })}
              </div>

              <button
                onClick={() => setShowFocusAnalysis(true)}
                className="hidden xl:flex items-center gap-2 min-w-[160px] justify-end rounded-md px-2 py-1 transition-colors"
                style={{ color: menuSub }}
                onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                title="Open detailed focus analysis"
              >
                <BarChart3 size={15} />
                <span className="text-[11px] font-medium truncate">
                  Best {format(focusStats.bestDay.day, 'EEE')} - {formatFocusDuration(focusStats.bestDay.seconds)}
                </span>
              </button>
            </div>

            {/* Focus timer controls */}
            <div className="px-4 pb-3 flex items-center gap-3 border-t" style={{ borderColor: surfaceBdr }}>
              <div className="pt-3 flex items-center gap-3 flex-1 min-w-0">
                <motion.div
                  className="relative text-2xl font-semibold tabular-nums leading-none flex-shrink-0"
                  style={{ color: focusCelebrate ? '#4ade80' : menuText }}
                  animate={focusCelebrate
                    ? { scale: [1, 1.16, 1, 1.08, 1], textShadow: ['0 0 0px rgba(74,222,128,0)', '0 0 18px rgba(74,222,128,0.75)', '0 0 0px rgba(74,222,128,0)'] }
                    : { scale: 1 }}
                  transition={focusCelebrate ? { duration: 1.5, ease: 'easeInOut' } : { duration: 0.3 }}
                >
                  {formatCountdown(focusRemainingSeconds)}
                  <AnimatePresence>
                    {focusCelebrate && (
                      <motion.span
                        key="focus-done"
                        initial={{ opacity: 0, y: 6, scale: 0.85 }}
                        animate={{ opacity: 1, y: -18, scale: 1 }}
                        exit={{ opacity: 0, y: -26 }}
                        transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
                        className="absolute left-0 top-0 text-[10px] font-bold uppercase tracking-widest whitespace-nowrap"
                        style={{ color: '#4ade80' }}
                      >
                        Session complete
                      </motion.span>
                    )}
                  </AnimatePresence>
                </motion.div>
                <div className="flex-1 min-w-[80px] max-w-[220px] h-1.5 rounded-full overflow-hidden" style={{ background: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${focusProgressPct}%`,
                      background: focusTimer.isRunning ? '#60a5fa' : darkMode ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.28)',
                    }}
                  />
                </div>
                <button
                  onClick={() => adjustFocusMinutes(-5)}
                  className="w-7 h-7 rounded-md flex items-center justify-center transition-all active:scale-[0.96] flex-shrink-0"
                  title="Decrease focus duration by 5 minutes"
                  style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuSub }}
                >
                  <Minus size={12} />
                </button>
                <div
                  className="h-7 rounded-md flex items-center justify-center px-2 flex-shrink-0"
                  style={{ background: darkMode ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.08)', border: '1px solid rgba(96,165,250,0.24)', color: menuText, minWidth: 64 }}
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
                      className="w-full bg-transparent outline-none text-center text-xs font-semibold tabular-nums"
                      style={{ color: menuText }}
                    />
                  ) : (
                    <button
                      onClick={() => setEditingFocusMinutes(true)}
                      className="w-full h-full text-xs font-semibold tabular-nums cursor-text"
                      title="Click to type a focus duration"
                    >
                      {Math.max(1, Math.round(focusTimer.plannedSeconds / 60))} min
                    </button>
                  )}
                </div>
                <button
                  onClick={() => adjustFocusMinutes(5)}
                  className="w-7 h-7 rounded-md flex items-center justify-center transition-all active:scale-[0.96] flex-shrink-0"
                  title="Increase focus duration by 5 minutes"
                  style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuSub }}
                >
                  <Plus size={12} />
                </button>
              </div>
              <div className="pt-3 flex items-center gap-1.5 flex-shrink-0">
                <button
                  onClick={focusTimer.isRunning ? pauseFocus : startFocus}
                  className="h-7 px-3 rounded-md flex items-center justify-center gap-1.5 text-xs font-semibold transition-all active:scale-[0.98]"
                  style={{
                    background: focusTimer.isRunning ? 'rgba(245,158,11,0.18)' : '#2563eb',
                    border: `1px solid ${focusTimer.isRunning ? 'rgba(245,158,11,0.35)' : '#2563eb'}`,
                    color: focusTimer.isRunning ? '#fbbf24' : '#ffffff',
                  }}
                >
                  {focusTimer.isRunning ? <Pause size={12} /> : <Play size={12} />}
                  {focusTimer.isRunning ? 'Pause' : focusElapsedSeconds > 0 ? 'Resume' : 'Start'}
                </button>
                <button
                  onClick={resetFocus}
                  disabled={focusElapsedSeconds <= 0}
                  className="w-7 h-7 rounded-md flex items-center justify-center transition-all active:scale-[0.98]"
                  title="Reset focus timer"
                  style={{ background: 'transparent', border: `1px solid ${surfaceBdr}`, color: menuSub, opacity: focusElapsedSeconds <= 0 ? 0.4 : 1 }}
                >
                  <RotateCcw size={12} />
                </button>
                <button
                  onClick={stopFocus}
                  disabled={focusElapsedSeconds <= 0}
                  className="h-7 px-3 rounded-md flex items-center justify-center gap-1.5 text-xs font-semibold transition-all active:scale-[0.98]"
                  title="Stop and log focus time"
                  style={{
                    background: focusElapsedSeconds > 0 ? (darkMode ? 'rgba(34,197,94,0.14)' : 'rgba(34,197,94,0.10)') : 'transparent',
                    border: `1px solid ${focusElapsedSeconds > 0 ? 'rgba(34,197,94,0.35)' : surfaceBdr}`,
                    color: focusElapsedSeconds > 0 ? '#4ade80' : menuSub,
                    opacity: focusElapsedSeconds <= 0 ? 0.4 : 1,
                  }}
                >
                  Stop
                </button>
              </div>
            </div>
          </section>
          )}
          <AnimatePresence mode="wait">
            {isTimelineView ? (
              <motion.div
                key="week-view-wrapper"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.08, ease: 'easeOut' }}
              >
                <AnimatePresence initial={false} custom={direction} mode="wait">
            <motion.div
              // Day view slides per day; week view per week.
              key={isDayView ? `d:${format(currentDate, 'yyyy-MM-dd')}` : isCustomView ? `c:${weekStart.toISOString()}:${customFrom}:${customTo}` : `w:${weekStart.toISOString()}`}
              custom={direction}
              variants={{
                enter:  (d: number) => ({ x: d>0?10:d<0?-10:0, opacity: 0 }),
                center: { x: 0, opacity: 1 },
                exit:   (d: number) => ({ x: d<0?10:d>0?-10:0, opacity: 0 }),
              }}
              initial="enter" animate="center" exit="exit"
              // Snappy: holding the week keys should feel instant, not springy.
              transition={{ x: { type: 'spring', stiffness: 2200, damping: 65, mass: 0.2 }, opacity: { duration: 0.04 } }}
              className="flex border border-border/60 rounded-xl overflow-hidden shadow-md relative z-10"
              style={{ background: darkMode ? currentDarkTheme.cardBg : '#ffffff' }}
            >
              {/* Loading skeleton — a few shimmering placeholder blocks so the first
                  paint reads as "loading" rather than "your week is empty". */}
              <AnimatePresence>
                {eventsLoading && (
                  <motion.div
                    key="grid-skeleton"
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    transition={{ duration: 0.25 }}
                    className="absolute inset-0 z-[60] pointer-events-none"
                    style={{ background: darkMode ? 'rgba(20,22,24,0.72)' : 'rgba(250,250,249,0.78)', backdropFilter: 'blur(1px)' }}
                  >
                    {[
                      { l: '10%', t: 140, h: 70 }, { l: '25%', t: 220, h: 110 },
                      { l: '40%', t: 120, h: 90 },  { l: '55%', t: 260, h: 60 },
                      { l: '70%', t: 180, h: 130 }, { l: '85%', t: 150, h: 80 },
                    ].map((b, i) => (
                      <motion.div
                        key={i}
                        className="absolute rounded-lg"
                        style={{ left: b.l, top: b.t, width: '11%', height: b.h, background: darkMode ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)' }}
                        animate={{ opacity: [0.35, 0.85, 0.35] }}
                        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', delay: i * 0.12 }}
                      />
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Time axis */}
              <div className="flex-shrink-0 border-r border-border/50" style={{ width: 64, background: darkMode ? 'rgba(0,0,0,0.20)' : 'rgba(255,255,255,0.40)' }}>
                <div style={{ height: HEADER_PX }} className="border-b border-border/50" />
                <div style={{ height: allDayHeight }} className="border-b border-border/50 flex items-center justify-center">
                  <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider text-center">All Day</span>
                </div>
                {showTaskBand && (
                  <div style={{ height: taskRowHeight }} className="border-b border-border/50 flex items-center justify-center gap-1">
                    <ListTodo size={10} style={{ color: taskColor, opacity: 0.8 }} />
                    <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider">Tasks</span>
                  </div>
                )}
                {showPrayerBand && (
                  <div style={{ height: prayerRowHeight }} className="border-b border-border/50 flex items-center justify-center gap-1">
                    <Moon size={10} style={{ color: prayer.color, opacity: 0.85 }} />
                    <span className="text-[10px] font-bold text-muted-foreground/60 uppercase tracking-wider">Prayer</span>
                  </div>
                )}
                <div className="relative" style={{ height: totalH }}>
                  {slots.map((time, i) => {
                    const isHour = time.endsWith(':00');
                    return (
                      <div key={time} className="absolute w-full flex justify-center items-start" style={{ top: i*sh, height: sh, transform: 'translateY(-50%)' }}>
                        <span className={`leading-none px-1 tabular-nums ${isHour ? 'text-[10px] font-bold text-muted-foreground' : 'text-[8.5px] text-muted-foreground/40'}`}>
                          {formatSlotLabel(time, timeFormat)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Day columns */}
              <div
                ref={daysGridRef}
                className="flex-1 grid relative"
                style={{ gridTemplateColumns: `repeat(${colCount}, minmax(0, 1fr))` }}
              >
                {visibleCols.map((colIdx) => {
                  const day       = dayAt(colIdx);
                  const today     = isSameDay(day, nowOwnerDate);
                  // The column that actually contains "now" (see nowColIdx: before the
                  // day-start hour that's yesterday's column, not today's).
                  const isNowCol  = colIdx === nowColIdx;

                  // An event "spans the day boundary" when it starts before the configured
                  // day-start hour and ends after it (e.g. sleep from 1:15am to 9:45am with a
                  // 7am day cutoff) — it can't be drawn as one block in a single column, so it
                  // renders as a linked tail (in its own day) + head (in the next day) segment.
                  const isBoundarySpanning = (ev: PlannerEvent) => {
                    const s = normalizeMin(timeToMin(ev.startTime), dayStartH);
                    let e = normalizeMin(timeToMin(ev.endTime), dayStartH);
                    if (e <= s) e += 1440;
                    return s < dayStartMin + 1440 && e > dayStartMin + 1440;
                  };

                    type RenderItem = { ev: PlannerEvent; key: string; startMin: number; endMin: number; segKind: 'normal' | 'tail' | 'head' };
                    const renderItems: RenderItem[] = [];
                    for (const ev of Object.values(weekEvents)) {
                      if (ev.allDay) continue; // Skip all-day events in the timeline grid
                      
                      const isDrag      = dragDisp?.id === ev.id;
                      const isBatchDrag = !!(batchDisp && batchDisp[ev.id]);
                      const isDragging  = isDrag || isBatchDrag;
                      const isResizing  = resizeDisp?.id === ev.id;

                      const origStart24 = timeToMin(ev.startTime);
                      const origEnd24   = timeToMin(ev.endTime);
                      const origS       = normalizeMin(origStart24, dayStartH);
                      let origE         = normalizeMin(origEnd24, dayStartH);
                      if (origE <= origS) origE += 1440;

                      let targetDayIndex = ev.dayIndex;
                      let targetStart24  = origStart24;
                      let targetEnd24    = origEnd24;

                      if (isDrag && dragDisp) {
                        targetDayIndex = dragDisp.day;
                        targetStart24  = dragDisp.startMin >= 1440 ? dragDisp.startMin - 1440 : dragDisp.startMin;
                        const dur      = normDuration(ev);
                        targetEnd24    = (targetStart24 + dur) % 1440;
                      } else if (isBatchDrag && batchDisp?.[ev.id]) {
                        const bd       = batchDisp[ev.id];
                        targetDayIndex = bd.dayIndex;
                        targetStart24  = bd.startMin >= 1440 ? bd.startMin - 1440 : bd.startMin;
                        const dur      = normDuration(ev);
                        targetEnd24    = (targetStart24 + dur) % 1440;
                      } else if (isResizing && resizeDisp) {
                        targetStart24  = resizeDisp.startMin >= 1440 ? resizeDisp.startMin - 1440 : resizeDisp.startMin;
                        const dur      = resizeDisp.endMin - resizeDisp.startMin;
                        targetEnd24    = (targetStart24 + dur) % 1440;
                      }

                      const targetS = normalizeMin(targetStart24, dayStartH);
                      let targetE   = normalizeMin(targetEnd24, dayStartH);
                      if (targetE <= targetS) targetE += 1440;

                      if (isDragging) {
                        // 1. Dashed placeholder preview at the target drop location
                        const phEv = { ...ev, isPlaceholder: true } as PlannerEvent;
                        const phSpanning = targetS < dayStartMin + 1440 && targetE > dayStartMin + 1440;
                        if (phSpanning) {
                          if (targetDayIndex === colIdx) {
                            renderItems.push({ ev: phEv, key: `${ev.id}__tail_ph`, startMin: targetS, endMin: dayStartMin + 1440, segKind: 'tail' });
                          }
                          if (targetDayIndex + 1 === colIdx) {
                            renderItems.push({ ev: phEv, key: `${ev.id}__head_ph`, startMin: dayStartMin, endMin: targetE - 1440, segKind: 'head' });
                          }
                        } else {
                          if (targetDayIndex === colIdx) {
                            renderItems.push({ ev: phEv, key: `${ev.id}__ph`, startMin: targetS, endMin: targetE, segKind: 'normal' });
                          }
                        }

                        // 2. Active floating element anchored to its original position (translated via dragDelta 1:1 with mouse)
                        const origSpanning = origS < dayStartMin + 1440 && origE > dayStartMin + 1440;
                        if (origSpanning) {
                          if (ev.dayIndex === colIdx) {
                            renderItems.push({ ev, key: `${ev.id}__tail_drag`, startMin: origS, endMin: dayStartMin + 1440, segKind: 'tail' });
                          }
                          if (ev.dayIndex + 1 === colIdx) {
                            renderItems.push({ ev, key: `${ev.id}__head_drag`, startMin: dayStartMin, endMin: origE - 1440, segKind: 'head' });
                          }
                        } else {
                          if (ev.dayIndex === colIdx) {
                            renderItems.push({ ev, key: `${ev.id}__drag`, startMin: origS, endMin: origE, segKind: 'normal' });
                          }
                        }
                      } else if (isResizing) {
                        const isSpanning = targetS < dayStartMin + 1440 && targetE > dayStartMin + 1440;
                        if (isSpanning) {
                          if (targetDayIndex === colIdx) {
                            renderItems.push({ ev, key: `${ev.id}__tail_resize`, startMin: targetS, endMin: dayStartMin + 1440, segKind: 'tail' });
                          }
                          if (targetDayIndex + 1 === colIdx) {
                            renderItems.push({ ev, key: `${ev.id}__head_resize`, startMin: dayStartMin, endMin: targetE - 1440, segKind: 'head' });
                          }
                        } else {
                          if (targetDayIndex === colIdx) {
                            renderItems.push({ ev, key: `${ev.id}__resize`, startMin: targetS, endMin: targetE, segKind: 'normal' });
                          }
                        }
                      } else {
                        // Stationary static event
                        const isSpanning = origS < dayStartMin + 1440 && origE > dayStartMin + 1440;
                        if (isSpanning) {
                          if (ev.dayIndex === colIdx) {
                            renderItems.push({ ev, key: ev.id, startMin: origS, endMin: dayStartMin + 1440, segKind: 'tail' });
                          }
                          if (ev.dayIndex + 1 === colIdx) {
                            renderItems.push({ ev, key: `${ev.id}__head`, startMin: dayStartMin, endMin: origE - 1440, segKind: 'head' });
                          }
                        } else {
                          if (ev.dayIndex === colIdx) {
                            renderItems.push({ ev, key: ev.id, startMin: origS, endMin: origE, segKind: 'normal' });
                          }
                        }
                      }
                    }
                    const colEvents = renderItems;

                  // Timed tasks share this column's sub-column layout with events, so
                  // a task overlapping a meeting sits beside it instead of on top.
                  // `layoutParallel` is structurally typed, so they can just join the
                  // same input list.
                  const colTimedTasks = (showTaskBand ? timedTasksByCol.get(colIdx) : undefined) ?? [];
                  const timedTaskItems = colTimedTasks.map(t => {
                    const s = normalizeMin(timeToMin(t.startTime!), dayStartH);
                    let e = normalizeMin(timeToMin(t.endTime || t.startTime!), dayStartH);
                    if (e <= s) e = s + 30;
                    return { task: t, key: `task:${t.id}`, startMin: s, endMin: e };
                  });

                  // Compute parallel layout for this column, excluding placeholders to prevent shrinking
                  const layoutInput = colEvents
                    .filter(item => !(item.ev as any).isPlaceholder)
                    .map(item => ({ id: item.key, startMin: item.startMin, endMin: item.endMin }))
                    .concat(timedTaskItems.map(t => ({ id: t.key, startMin: t.startMin, endMin: t.endMin })));
                  const layout = layoutParallel(layoutInput);

                  return (
                    <div key={colIdx} className="flex flex-col border-r border-border/50 last:border-r-0 relative"
                      style={{
                        // Today gets a clearly stronger wash plus edge rails, so the column
                        // reads as "the current day" at a glance instead of a faint tint.
                        background: today
                          ? (darkMode ? 'rgba(110,180,120,0.13)' : 'rgba(90,160,100,0.10)')
                          : 'transparent',
                        boxShadow: today
                          ? (darkMode
                              ? 'inset 1px 0 0 rgba(130,200,140,0.45), inset -1px 0 0 rgba(130,200,140,0.45)'
                              : 'inset 1px 0 0 rgba(70,140,85,0.35), inset -1px 0 0 rgba(70,140,85,0.35)')
                          : undefined,
                      }}>
                      {/* Day header */}
                      <div
                        className={`flex-shrink-0 flex flex-col items-center justify-center border-b relative ${today ? 'border-primary/40' : 'border-border/50'}`}
                        style={{
                          height: HEADER_PX,
                          background: today
                            ? (darkMode ? 'rgba(110,180,120,0.16)' : 'rgba(90,160,100,0.14)')
                            : 'transparent',
                        }}
                      >
                        {/* Accent rail across the top of today's column */}
                        {today && (
                          <div
                            className="absolute top-0 left-0 right-0"
                            style={{ height: 3, background: darkMode ? 'rgb(134,206,145)' : 'rgb(63,138,80)' }}
                          />
                        )}
                        <span className={`text-[9px] font-bold uppercase tracking-widest mb-0.5 ${today ? 'text-primary' : 'text-muted-foreground'}`}>{format(day, 'EEE')}</span>
                        {today ? (
                          <span
                            className="text-lg font-bold leading-none flex items-center justify-center rounded-full"
                            style={{
                              width: 30,
                              height: 30,
                              color: '#fff',
                              background: darkMode ? 'rgb(88,168,104)' : 'rgb(63,138,80)',
                              boxShadow: darkMode
                                ? '0 0 0 3px rgba(134,206,145,0.22)'
                                : '0 0 0 3px rgba(63,138,80,0.16)',
                            }}
                          >
                            {format(day, 'd')}
                          </span>
                        ) : (
                          <span className="text-lg font-semibold leading-none text-foreground/70">{format(day, 'd')}</span>
                        )}
                      </div>

                      {/* All-day cell placeholder */}
                      <div
                        style={{ height: allDayHeight }}
                        className="flex-shrink-0 border-b border-border/50 relative group"
                      >
                        {/* "+" add button on hover */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedIds(new Set());
                            const id = uid();
                            createStamped(
                              { id, dayIndex: colIdx, startTime: "00:00", endTime: "00:30", allDay: true, content: '', color: 'sage' },
                              { edit: true, menuAt: { x: e.clientX + 10, y: e.clientY } }
                            );
                          }}
                          className="absolute right-1 bottom-1 w-5 h-5 rounded-md flex items-center justify-center transition-all bg-background/70 hover:bg-background border border-border/40 opacity-0 group-hover:opacity-100 shadow-sm active:scale-95 z-20"
                          style={{ color: menuSub }}
                        >
                          <Plus size={11} />
                        </button>
                      </div>

                      {/* Task band — dated tasks with no time. A task never spans
                          days, so each chip lives in its own column cell; there is
                          no absolute overlay to keep in sync. */}
                      {showTaskBand && (
                        <div
                          style={{
                            height: taskRowHeight,
                            background: taskDropCol === colIdx ? `${taskColor}22` : undefined,
                            outline: taskDropCol === colIdx ? `1px dashed ${taskColor}` : undefined,
                            outlineOffset: -2,
                          }}
                          className="flex-shrink-0 border-b border-border/50 relative group px-1 py-1 flex flex-col gap-[2px] overflow-hidden"
                          onDragOver={(e) => {
                            if (!taskDragId) return;
                            e.preventDefault();                       // required, or the drop never fires
                            e.dataTransfer.dropEffect = 'move';
                            if (taskDropCol !== colIdx) setTaskDropCol(colIdx);
                          }}
                          onDragLeave={(e) => {
                            // Ignore the leave events fired while crossing this cell's
                            // own children, or the highlight strobes.
                            if (e.currentTarget.contains(e.relatedTarget as Node)) return;
                            setTaskDropCol(c => (c === colIdx ? null : c));
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            const id = taskDragId || e.dataTransfer.getData('text/planner-task');
                            setTaskDropCol(null);
                            setTaskDragId(null);
                            if (!id) return;
                            // Which chip was it dropped above? Compare against the
                            // vertical midpoint of each chip already in the column.
                            const chips = [...e.currentTarget.querySelectorAll('[data-task-chip]')] as HTMLElement[];
                            let beforeId: string | null = null;
                            for (const chip of chips) {
                              const r = chip.getBoundingClientRect();
                              if (e.clientY < r.top + r.height / 2) {
                                beforeId = chip.getAttribute('data-task-chip');
                                break;
                              }
                            }
                            if (beforeId === id) beforeId = null;
                            moveTaskToColumn(id, colIdx, beforeId);
                          }}
                        >
                          {(datedTasksByCol.get(colIdx) ?? []).map(t => {
                            const occ = t.occDate ?? null;
                            const done = isTaskDone(t, occ);
                            const c = taskChipColors(t.color || undefined);
                            return (
                              <button
                                key={t.id}
                                data-task="1"
                                data-task-chip={t.id}
                                draggable
                                onDragStart={(e) => {
                                  setTaskDragId(t.id);
                                  e.dataTransfer.effectAllowed = 'move';
                                  e.dataTransfer.setData('text/planner-task', t.id);
                                }}
                                onDragEnd={() => { setTaskDragId(null); setTaskDropCol(null); }}
                                onClick={(e) => { e.stopPropagation(); openTaskMenu(t.id, { x: e.clientX + 8, y: e.clientY }); }}
                                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openTaskMenu(t.id, { x: e.clientX, y: e.clientY }); }}
                                className="flex items-center gap-1 rounded-[5px] px-1.5 text-left transition-opacity cursor-grab active:cursor-grabbing"
                                style={{
                                  height: TASK_CHIP_H,
                                  background: c.bg,
                                  border: `1px dashed ${c.border}`,
                                  opacity: taskDragId === t.id ? 0.4 : done ? 0.5 : 1,
                                  filter: done ? 'saturate(0.4)' : 'none',
                                }}
                                title={`${t.title} — drag to another day, or up and down to reorder`}
                              >
                                <span
                                  role="button"
                                  tabIndex={-1}
                                  onClick={(e) => { e.stopPropagation(); handleToggleTaskDone(t.id); }}
                                  className="flex-shrink-0 flex items-center justify-center"
                                  style={{ color: c.text }}
                                >
                                  {done ? <CheckSquare size={10} /> : <Square size={10} />}
                                </span>
                                <span
                                  className="text-[10.5px] font-medium truncate leading-none"
                                  style={{ color: c.text, textDecoration: done ? 'line-through' : 'none' }}
                                >
                                  {t.title || 'Untitled task'}
                                </span>
                                {t.recur && <Repeat size={8} style={{ color: c.textMuted, flexShrink: 0 }} />}
                              </button>
                            );
                          })}
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              const id = createTask({
                                title: 'New task',
                                dueDate: format(dayAt(colIdx), 'yyyy-MM-dd'),
                              });
                              if (id) openTaskMenu(id, { x: e.clientX + 10, y: e.clientY });
                            }}
                            className="absolute right-1 bottom-1 w-5 h-5 rounded-md flex items-center justify-center transition-all bg-background/70 hover:bg-background border border-border/40 opacity-0 group-hover:opacity-100 shadow-sm active:scale-95 z-20"
                            style={{ color: menuSub }}
                            title="Add a task on this day"
                          >
                            <Plus size={11} />
                          </button>
                        </div>
                      )}

                      {/* Prayer band — the whole calendar day's prayers, including
                          the ones that fall outside the visible hour window. */}
                      {showPrayerBand && (
                        <div
                          style={{ height: prayerRowHeight }}
                          className="flex-shrink-0 border-b border-border/50 px-1 py-1 flex flex-col gap-[2px] overflow-hidden"
                        >
                          {prayersFor(day).map(p => {
                            const done = isPrayerDone(p.dateStr, p.key);
                            return (
                              <button
                                key={p.id}
                                onClick={(e) => { e.stopPropagation(); togglePrayerDone(p.dateStr, p.key); }}
                                className="flex items-center gap-1 rounded-[5px] px-1.5 text-left transition-opacity"
                                style={{
                                  height: PRAYER_CHIP_H,
                                  background: `${prayer.color}22`,
                                  border: `1px solid ${prayer.color}66`,
                                  opacity: done ? 0.5 : 1,
                                }}
                                title={`${p.label} · ${formatTimeLabel(p.minutes, timeFormat)}${done ? ' · done' : ''}`}
                              >
                                <span className="flex-shrink-0 flex items-center" style={{ color: prayer.color }}>
                                  {done ? <CheckCircle2 size={10} /> : <Circle size={10} />}
                                </span>
                                <span
                                  className="text-[10px] font-semibold truncate leading-none"
                                  style={{ color: prayer.color, textDecoration: done ? 'line-through' : 'none' }}
                                >
                                  {p.label}
                                </span>
                                <span className="text-[9.5px] tabular-nums leading-none ml-auto opacity-80" style={{ color: prayer.color }}>
                                  {formatTimeLabel(p.minutes, timeFormat)}
                                </span>
                              </button>
                            );
                          })}
                        </div>
                      )}

                      {/* Content area */}
                      <div className="relative" style={{ height: totalH, cursor: isDraggingAnything ? 'grabbing' : 'crosshair' }}
                        onClick={(e) => handleColClick(e, colIdx)}
                        onMouseDown={(e) => {
                          if ((e.target as HTMLElement).closest('[data-event]') || (e.target as HTMLElement).closest('[data-task]')) return;
                          if (e.button !== 0) return;
                          if (!e.ctrlKey && !e.metaKey) {
                            setSelectedIds(new Set());
                          }
                          const rect = e.currentTarget.getBoundingClientRect();
                          const y = e.clientY - rect.top;
                          if (e.ctrlKey || e.metaKey) {
                            const gr = daysGridRef.current?.getBoundingClientRect();
                            if (gr) {
                              const sx = e.clientX - gr.left;
                              const sy = e.clientY - gr.top - topBandsHeight;
                              selDragRef.current = { startX: sx, startY: sy };
                              setSelRect({ left: sx, top: sy, width: 0, height: 0 });
                            }
                          } else {
                            // Plain left-drag on empty space â†’ create a new event spanning the drag
                            createDragRef.current = { col: colIdx, startY: y, moved: false };
                          }
                        }}
                      >
                        {/* Grid lines */}
                        {slots.map((time, i) => (
                          <div key={time} className={`absolute w-full pointer-events-none border-b ${time.endsWith(':00') ? 'border-border/35' : 'border-border/12'}`} style={{ top: i*sh, height: sh }} />
                        ))}

                        {/* Live time indicator */}
                        {isNowCol && nowInView && (() => {
                          const lineTop = minToY(nowMin, interval, dayStartH);
                          return (
                            <div ref={nowLineRef} className="absolute left-0 right-0 z-30 pointer-events-none" style={{ top: lineTop, height: 0 }}>
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

                        {/* Prayer times. Zero-height overlays anchored to the exact
                            minute — they must never eat a click meant for the grid,
                            so only the chip itself takes pointer events. */}
                        {prayer.style !== 'row' && columnPrayers(day).map(p => {
                          const norm = p.norm;
                          if (norm < dayStartMin || norm > dayEndMin) return null;
                          const top = minToY(norm, interval, dayStartH);
                          const done = isPrayerDone(p.dateStr, p.key);
                          const label = `${p.label} · ${formatTimeLabel(p.minutes, timeFormat)}`;

                          if (prayer.style === 'pill') {
                            return (
                              <button
                                key={p.id}
                                onClick={(e) => { e.stopPropagation(); togglePrayerDone(p.dateStr, p.key); }}
                                className="absolute flex items-center gap-1 rounded-md px-1.5 z-20 transition-opacity"
                                style={{
                                  top, left: 2, right: 2, height: 16,
                                  background: `${prayer.color}26`,
                                  border: `1px solid ${prayer.color}80`,
                                  opacity: done ? 0.5 : 1,
                                }}
                                title={label}
                              >
                                <span className="flex-shrink-0 flex items-center" style={{ color: prayer.color }}>
                                  {done ? <CheckCircle2 size={9} /> : <Circle size={9} />}
                                </span>
                                <span
                                  className="text-[9.5px] font-semibold truncate leading-none"
                                  style={{ color: prayer.color, textDecoration: done ? 'line-through' : 'none' }}
                                >
                                  {p.label}
                                </span>
                                <span className="text-[9px] tabular-nums leading-none ml-auto opacity-80" style={{ color: prayer.color }}>
                                  {formatTimeLabel(p.minutes, timeFormat)}
                                </span>
                              </button>
                            );
                          }

                          return (
                            <div
                              key={p.id}
                              className="absolute left-0 right-0 z-20 pointer-events-none"
                              style={{ top, height: 0, opacity: done ? 0.45 : 1 }}
                            >
                              <div
                                className="absolute left-0 right-0"
                                style={{ height: 0, borderTop: `1px dashed ${prayer.color}`, opacity: 0.85 }}
                              />
                              <button
                                onClick={(e) => { e.stopPropagation(); togglePrayerDone(p.dateStr, p.key); }}
                                className="absolute flex items-center gap-1 rounded-full pl-1 pr-1.5 pointer-events-auto"
                                style={{
                                  left: 2, top: -7, height: 14,
                                  background: `${prayer.color}26`,
                                  border: `1px solid ${prayer.color}80`,
                                  backdropFilter: 'blur(2px)',
                                }}
                                title={`${label}${done ? ' · done' : ''}`}
                              >
                                <span className="flex items-center" style={{ color: prayer.color }}>
                                  {done ? <CheckCircle2 size={9} /> : <Circle size={9} />}
                                </span>
                                <span
                                  className="text-[9px] font-bold leading-none whitespace-nowrap"
                                  style={{ color: prayer.color, textDecoration: done ? 'line-through' : 'none' }}
                                >
                                  {p.label}
                                </span>
                                <span className="text-[8.5px] tabular-nums leading-none opacity-80 whitespace-nowrap" style={{ color: prayer.color }}>
                                  {formatTimeLabel(p.minutes, timeFormat)}
                                </span>
                              </button>
                            </div>
                          );
                        })}

                        {/* Events */}
                        {colEvents.map(item => {
                          const { ev, key: itemKey, segKind } = item;
                          const top      = minToY(item.startMin, interval, dayStartH);
                          const height   = Math.max(sh, minToY(item.endMin, interval, dayStartH) - top);
                          const isDrag   = dragDisp?.id === ev.id;
                          const isEdit   = editingId === ev.id;
                          const isHov    = hoveredId === ev.id;
                          const isMenu   = menuId === ev.id;
                          const isResize = resizeDisp?.id === ev.id;
                          const isSelected = selectedIds.has(ev.id);
                          const isBatchDrag = !!(batchDisp && batchDisp[ev.id]);
                          const isPlaceholder = (ev as any).isPlaceholder;
                          
                          // While actively dragging/resizing the block must track the cursor
                          // 1:1 (no easing, or it lags). The moment it settles, let its
                          // position/size glide to the snapped target for a smooth landing.
                          const isMoving = isDrag || isResize || isBatchDrag;
                          const blockTransition = isMoving
                            ? 'none'
                            : 'box-shadow 140ms ease, outline-color 140ms ease, transform 140ms cubic-bezier(0.22,1,0.36,1), filter 140ms ease';
                          const { bg, border, text, textMuted, boxShadow, accentBar } = chipColors(ev);
                          // Whether a card has room for its footer (the start–end line,
                          // and the colour swatches while editing). This is a PIXEL
                          // threshold on purpose: keying it to the slot height meant a
                          // 30-minute card lost its times at the 30m grid interval but
                          // kept them at 5m — same card, same pixels, different result.
                          const tooShort = height < 60;
                          // Duration always reflects the event's true full start–end, not just this segment.
                          const fullStartMin = timeToMin(ev.startTime);
                          const fullEndMin   = timeToMin(ev.endTime);

                          let activeStart24 = fullStartMin;
                          let activeEnd24   = fullEndMin;

                          if (isDrag && dragDisp) {
                            const normS   = dragDisp.startMin;
                            activeStart24 = normS >= 1440 ? normS - 1440 : normS;
                            const dur     = normDuration(ev);
                            activeEnd24   = (activeStart24 + dur) % 1440;
                          } else if (isBatchDrag && batchDisp?.[ev.id]) {
                            const normS   = batchDisp[ev.id].startMin;
                            activeStart24 = normS >= 1440 ? normS - 1440 : normS;
                            const dur     = normDuration(ev);
                            activeEnd24   = (activeStart24 + dur) % 1440;
                          } else if (isResize && resizeDisp) {
                            const normS   = resizeDisp.startMin;
                            activeStart24 = normS >= 1440 ? normS - 1440 : normS;
                            const normE   = resizeDisp.endMin;
                            activeEnd24   = normE >= 1440 ? normE - 1440 : normE;
                          }

                          const sNormEv = normalizeMin(activeStart24, dayStartH);
                          let eNormEv   = normalizeMin(activeEnd24, dayStartH);
                          if (eNormEv <= sNormEv) eNormEv += 1440;
                          const spansBoundary = sNormEv < dayStartMin + 1440 && eNormEv > dayStartMin + 1440;

                          // "Live" is scoped to this segment's own on-screen range (each segment lives in a
                          // different day column, so at most one of tail/head is ever the active one).
                          const isLive   = isNowCol && normNowMin >= item.startMin && normNowMin < item.endMin;
                          const minutesLeft = Math.max(0, isResize && resizeDisp
                            // Dragging an edge moves the finish line — the countdown has
                            // to follow it live, not the stored end time.
                            ? resizeDisp.endMin - normNowMin
                            : segKind === 'tail'
                              ? fullEndMin + 1440 - normNowMin
                              : segKind === 'head'
                                ? fullEndMin - normNowMin
                                : normalizeMin(fullEndMin, dayStartH) - normNowMin);

                          const durationMin = Math.max(0, (isDrag && dragDisp) || (isBatchDrag && batchDisp?.[ev.id])
                            ? normDuration(ev)
                            : isResize && resizeDisp
                              ? resizeDisp.endMin - resizeDisp.startMin
                              : eNormEv - sNormEv);

                          const durationLabel = durationMin < 60
                            ? `${durationMin} minute${durationMin === 1 ? '' : 's'}`
                            : durationMin % 60 === 0
                              ? `${durationMin / 60} hour${durationMin / 60 === 1 ? '' : 's'}`
                              : `${Math.floor(durationMin / 60)}h ${durationMin % 60}m`;

                          const layoutKey = isPlaceholder ? ev.id : itemKey;
                          const { col, numCols } = layout.get(layoutKey) ?? { col: 0, numCols: 1 };
                          const colW   = 100 / numCols;
                          const leftPct  = col * colW;
                          const rightPct = 100 - (col + 1) * colW;
                          // Convert percent to pixel offsets accounting for gap
                          const EDGE = 3; // px from column wall
                          // left/right in %, gap between parallel events
                          const gapOffset = numCols > 1 ? COL_GAP / 2 : 0;

                          const showTopTime    = isResize && resizeRef.current?.edge === 'top';
                          const showBottomTime = isResize && resizeRef.current?.edge === 'bottom';

                          if (isPlaceholder) {
                            return (
                              <div
                                key={itemKey}
                                className={`absolute rounded-lg border-2 border-dashed pointer-events-none z-0`}
                                style={{
                                  top, height,
                                  left:  `calc(${leftPct}% + ${EDGE + (col > 0 ? gapOffset : 0)}px)`,
                                  right: `calc(${rightPct}% + ${EDGE + (col < numCols-1 ? gapOffset : 0)}px)`,
                                  borderColor: border,
                                  backgroundColor: darkMode ? 'rgba(255,255,255,0.01)' : 'rgba(0,0,0,0.01)',
                                  opacity: 0.45,
                                }}
                              />
                            );
                          }

                          // Hovering lifts the block a hair; it settles back on release.
                          const lift = !isMoving && (isHov || isMenu || isEdit) ? -1.5 : 0;
                          const transform = (isMoving && dragDelta)
                            ? `translate3d(${dragDelta.x}px, ${dragDelta.y}px, 0)`
                            : `translate3d(0, ${lift}px, 0)`;

                          return (
                            <div
                              key={itemKey}
                              data-event="1"
                              data-event-id={ev.id}
                              title={ev.content}
                              className={`absolute border overflow-visible ${segKind === 'tail' ? 'rounded-t-lg' : segKind === 'head' ? 'rounded-b-lg' : 'rounded-lg'} ${isDrag ? 'shadow-lg z-50' : isEdit||isMenu ? 'z-40 shadow-md' : 'z-10 shadow-sm hover:shadow-md'}`}
                              style={{
                                top, height,
                                transition: blockTransition,
                                willChange: isMoving ? 'transform, top, height' : undefined,
                                transform,
                                transformOrigin: 'center center',
                                left:  `calc(${leftPct}% + ${EDGE + (col > 0 ? gapOffset : 0)}px)`,
                                right: `calc(${rightPct}% + ${EDGE + (col < numCols-1 ? gapOffset : 0)}px)`,
                                backgroundColor: bg,
                                borderColor: border,
                                borderBottomStyle: segKind === 'tail' ? 'dashed' : 'solid',
                                borderTopStyle: segKind === 'head' ? 'dashed' : 'solid',
                                color: text,
                                boxShadow: boxShadow || (lift ? '0 4px 14px rgba(0,0,0,0.18)' : undefined),
                                cursor: isDrag ? 'grabbing' : isEdit ? 'text' : 'pointer',
                                opacity: isDrag ? 0.95 : 1,
                                // A touch more saturation on hover so the block "wakes up".
                                filter: lift ? 'saturate(1.12) brightness(1.03)' : undefined,
                                outline: isMenu ? `2px solid ${text}` : isSelected ? `2px solid ${darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.45)'}` : 'none',
                                outlineOffset: 1,
                                pointerEvents: (isMoving && !isResize) ? 'none' : undefined,
                              }}
                              onMouseDown={(e) => handleEventMouseDown(e, ev, segKind)}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (e.ctrlKey || e.metaKey) {
                                  setSelectedIds(prev => { const n = new Set(prev); if (n.has(ev.id)) n.delete(ev.id); else n.add(ev.id); return n; });
                                  return;
                                }
                                if (!didDragRef.current) openMenu(e, ev);
                              }}
                              onDoubleClick={(e) => { e.stopPropagation(); openMenu(e, ev); enterEdit(ev.id); }}
                              onMouseEnter={() => setHoveredId(ev.id)}
                              onMouseLeave={() => setHoveredId(null)}
                            >
                              {/* Drag time tooltip */}
                              {isDrag && dragDisp && (
                                <div className="absolute z-50 pointer-events-none" style={{ top: -24, left: '50%', transform: 'translateX(-50%)' }}>
                                  <div className="text-[10px] font-semibold px-2 py-0.5 rounded whitespace-nowrap" style={{ background: text, color: bg, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
                                    {formatTimeLabel(activeStart24, timeFormat)} – {formatTimeLabel(activeEnd24, timeFormat)} ({durationLabel})
                                  </div>
                                </div>
                              )}

                              {/* Batch drag time tooltip */}
                              {isBatchDrag && batchDisp?.[ev.id] && (
                                <div className="absolute z-50 pointer-events-none" style={{ top: -24, left: '50%', transform: 'translateX(-50%)' }}>
                                  <div className="text-[10px] font-semibold px-2 py-0.5 rounded whitespace-nowrap" style={{ background: text, color: bg, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
                                    {formatTimeLabel(batchDisp[ev.id].startMin, timeFormat)} – {formatTimeLabel(batchDisp[ev.id].startMin + durationMin, timeFormat)}
                                  </div>
                                </div>
                              )}

                              {/* Short / Micro card hover detail tooltip */}
                              {height < 44 && isHov && !isMoving && (
                                <div className="absolute z-50 pointer-events-none" style={{ top: -24, left: '50%', transform: 'translateX(-50%)' }}>
                                  <div className="text-[10px] font-semibold px-2 py-0.5 rounded-md whitespace-nowrap shadow-md" style={{ background: text, color: bg, border: `1px solid ${border}` }}>
                                    {ev.content || 'Untitled'} · {formatTimeLabel(activeStart24, timeFormat)} – {formatTimeLabel(activeEnd24, timeFormat)} ({durationLabel})
                                  </div>
                                </div>
                              )}

                              {/* Continuation indicator (head segment: rest of event started the day before) */}
                              {segKind === 'head' && (
                                <div className="absolute top-0 left-0 right-0 flex items-center justify-center pointer-events-none" style={{ height: 10 }} title={`Continues from ${formatTimeLabel(fullStartMin, timeFormat)} the night before`}>
                                  <span style={{ fontSize: 9, lineHeight: 1, opacity: 0.55, color: text }}>⌃ continued</span>
                                </div>
                              )}

                              {/* Top resize handle */}
                              {segKind !== 'head' && (
                                <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center pointer-events-auto" style={{ height: height < 34 ? 6 : 10, cursor: 'n-resize', marginTop: height < 34 ? 0 : -2 }} onMouseDown={(e) => handleResizeMouseDown(e, ev, 'top', segKind)}>
                                  <div className="rounded-full transition-opacity duration-150" style={{ width: height < 34 ? 20 : 28, height: height < 34 ? 2 : 3, backgroundColor: text, opacity: isHov||isEdit||isMenu ? 0.6 : (height < 34 ? 0 : 0.25), pointerEvents: 'none' }} />
                                </div>
                              )}
                              {/* Top time tooltip */}
                              {showTopTime && resizeDisp && (
                                <div className="absolute z-50 pointer-events-none" style={{ top: -22, left: '50%', transform: 'translateX(-50%)' }}>
                                  <div className="text-[10px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap" style={{ background: text, color: bg, boxShadow: '0 1px 4px rgba(0,0,0,0.25)' }}>
                                    {formatTimeLabel(resizeDisp.startMin, timeFormat)}
                                  </div>
                                </div>
                              )}

                              {/* Content */}
                              {(() => {
                                const isMicroCard   = height < 26;
                                const isShortCard   = height >= 26 && height < 44;
                                const isCompactCard = height >= 44 && height < 64;
                                // A full card that is only just past the compact cut-off
                                // (a 30-minute block at the 30m interval, say) keeps the
                                // full-card layout but not its generous padding — that
                                // padding ate two of the three lines the title needed.
                                const isMediumCard  = height >= 64 && height < 104;
                                return (
                                  <div
                                    className={`absolute inset-0 flex flex-col overflow-hidden ${
                                      isMicroCard || isShortCard ? 'px-1.5 py-0' : isCompactCard || isMediumCard ? 'px-2 py-1' : 'px-2 pt-2.5 pb-2'
                                    }`}
                                    style={{
                                      top: isMicroCard ? 1 : isShortCard ? 2 : isCompactCard ? 3 : isMediumCard ? 3 : 6,
                                      bottom: isMicroCard ? 1 : isShortCard ? 2 : isCompactCard ? 4 : isMediumCard ? 3 : 8,
                                    }}
                                  >
                                    {isEdit ? (
                                      <>
                                        <textarea
                                          ref={editRef}
                                          value={ev.content}
                                          onChange={e => applyEdit(ev.id, { content: e.target.value })}
                                          onKeyDown={e => {
                                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finishEdit(); }
                                            if (e.key === 'Escape') finishEdit();
                                          }}
                                          onBlur={() => finishEdit()}
                                          onClick={e => e.stopPropagation()}
                                          className={`flex-1 w-full resize-none bg-transparent outline-none ${height < 34 ? 'text-[11px] leading-tight p-0' : 'text-xs leading-snug'} placeholder:opacity-40`}
                                          style={{ color: text, minHeight: 0 }}
                                          placeholder="What's happening?"
                                        />
                                        {!tooShort && (
                                          <div className="flex items-center gap-1 pt-1 flex-shrink-0" onMouseDown={e => e.preventDefault()}>
                                            {SWATCHES.map(c => {
                                              const sc = colorPalette[c];
                                              return (
                                                <button key={c} type="button"
                                                  onClick={e => { e.stopPropagation(); applyEdit(ev.id, { color: c }); }}
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

                                      if (isMicroCard) {
                                        // Tier 1: Micro Card (height < 26px, e.g. 5m - 10m)
                                        return (
                                          <div className="flex items-center gap-1 w-full h-full my-auto overflow-hidden text-xs px-0.5 leading-none">
                                            {today && !ev.noCheckbox && (
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  toggleEventCompleted(ev.id, day);
                                                }}
                                                className="flex-shrink-0 w-3 h-3 rounded-full border transition-all duration-150 flex items-center justify-center cursor-pointer"
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
                                              {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                                            </span>
                                          </div>
                                        );
                                      }

                                      if (isShortCard) {
                                        // Tier 2: Short Card (26px <= height < 44px, e.g. 15m - 25m)
                                        return (
                                          <div className="flex items-center gap-1.5 w-full h-full my-auto overflow-hidden text-xs px-0.5 leading-none">
                                            {today && !ev.noCheckbox && (
                                              <button
                                                type="button"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  toggleEventCompleted(ev.id, day);
                                                }}
                                                className="flex-shrink-0 w-3.5 h-3.5 rounded-full border transition-all duration-150 flex items-center justify-center cursor-pointer"
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
                                            <span className={`font-semibold truncate min-w-0 flex-shrink ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                                              {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                                            </span>
                                            <span className="text-[10px] font-medium tabular-nums flex-shrink-0 opacity-80 whitespace-nowrap leading-none" style={{ color: textMuted }}>
                                              · {formatTimeLabel(activeStart24, timeFormat)} – {formatTimeLabel(activeEnd24, timeFormat)}
                                            </span>
                                          </div>
                                        );
                                      }

                                      if (isCompactCard) {
                                        // Tier 3: Compact Card (44px <= height < 64px, e.g. 30m - 45m)
                                        return (
                                          <div className="flex flex-col justify-between w-full h-full overflow-hidden leading-tight py-0.5">
                                            <div className="flex items-center gap-1.5 w-full min-w-0 flex-shrink-0">
                                              {today && !ev.noCheckbox && (
                                                <button
                                                  type="button"
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    toggleEventCompleted(ev.id, day);
                                                  }}
                                                  className="flex-shrink-0 w-3.5 h-3.5 rounded-full border transition-all duration-150 flex items-center justify-center cursor-pointer"
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
                                              <span className={`text-xs font-semibold truncate leading-tight min-w-0 flex-1 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                                                {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                                              </span>
                                            </div>
                                            <span className="text-[9.5px] font-medium tabular-nums flex-shrink-0 opacity-85 leading-none mt-auto flex items-center gap-1 whitespace-nowrap" style={{ color: textMuted }}>
                                              {formatTimeLabel(activeStart24, timeFormat)} – {formatTimeLabel(activeEnd24, timeFormat)}
                                              {isLive ? (
                                                <span className="inline-flex items-center gap-0.5" style={{ opacity: 1, color: darkMode ? '#ff8a8a' : '#dc2626' }}>
                                                  <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: darkMode ? '#ff8a8a' : '#dc2626' }} />
                                                  {minutesLeft}m left
                                                </span>
                                              ) : (
                                                <span>({durationLabel})</span>
                                              )}
                                            </span>
                                          </div>
                                        );
                                      }

                                      // Tier 4: Full Card (height >= 64px, e.g. 1h+)
                                      return (
                                        <>
                                          {/* Top time label */}
                                          {durationMin >= 60 && (
                                            <span className="text-[9.5px] font-semibold tabular-nums flex-shrink-0 mb-0.5 flex items-center justify-center w-full text-center gap-1 opacity-90" style={{ color: textMuted }}>
                                              {formatTimeLabel(activeStart24, timeFormat)} – {formatTimeLabel(activeEnd24, timeFormat)}
                                              {isLive ? (
                                                <span className="inline-flex items-center gap-0.5" style={{ opacity: 1, color: darkMode ? '#ff8a8a' : '#dc2626' }}>
                                                  <span className="w-1 h-1 rounded-full flex-shrink-0" style={{ background: darkMode ? '#ff8a8a' : '#dc2626' }} />
                                                  {formatTimeLeft(minutesLeft)}
                                                </span>
                                              ) : (
                                                <span>({durationLabel})</span>
                                              )}
                                            </span>
                                          )}
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
                                            <p className={`font-medium break-words line-clamp-5 ${isMediumCard ? 'text-[10.5px] leading-tight' : 'text-xs leading-snug'} ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                                              {ev.content || <span style={{ opacity: 0.3, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                                            </p>
                                          </div>
                                          {!tooShort && (
                                            <span className="text-[9.5px] font-medium tabular-nums flex-shrink-0 mt-auto flex items-center gap-1" style={{ color: textMuted }}>
                                              {formatTimeLabel(activeStart24, timeFormat)} – {formatTimeLabel(activeEnd24, timeFormat)}
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

                              {/* Bottom resize handle */}
                              {segKind !== 'tail' && (
                                <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center pointer-events-auto" style={{ height: height < 34 ? 6 : 10, cursor: 's-resize', marginBottom: height < 34 ? 0 : -2 }} onMouseDown={(e) => handleResizeMouseDown(e, ev, 'bottom', segKind)}>
                                  <div className="rounded-full transition-opacity duration-150" style={{ width: height < 34 ? 20 : 28, height: height < 34 ? 2 : 3, backgroundColor: text, opacity: isHov||isEdit||isMenu ? 0.6 : (height < 34 ? 0 : 0.25), pointerEvents: 'none' }} />
                                </div>
                              )}

                              {/* Continuation indicator (tail segment: event keeps going into the next day) */}
                              {segKind === 'tail' && (
                                <div className="absolute bottom-0 left-0 right-0 flex items-center justify-center pointer-events-none" style={{ height: 10 }} title={`Continues until ${formatTimeLabel(fullEndMin, timeFormat)}`}>
                                  <span style={{ fontSize: 9, lineHeight: 1, opacity: 0.55, color: text }}>continued ⌄</span>
                                </div>
                              )}

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

                        {/* Timed tasks. Drawn after the event cards so they sit on
                            top when they overlap, and marked `data-task` (never
                            `data-event`) so the drag/resize/marquee machinery, which
                            is all PlannerData-typed, leaves them alone. */}
                        {timedTaskItems.map(({ task: t, key, startMin, endMin }) => {
                          const occ = t.occDate ?? null;
                          const done = isTaskDone(t, occ);
                          const c = taskChipColors(t.color || undefined);
                          const top = minToY(startMin, interval, dayStartH);
                          const h = Math.max(18, minToY(endMin, interval, dayStartH) - top);
                          const { col, numCols } = layout.get(key) ?? { col: 0, numCols: 1 };
                          const colW = 100 / numCols;
                          const EDGE = 3;
                          const gapOffset = numCols > 1 ? COL_GAP / 2 : 0;
                          return (
                            <div
                              key={key}
                              data-task="1"
                              data-task-chip={t.id}
                              draggable
                              onDragStart={(e) => {
                                setTaskDragId(t.id);
                                e.dataTransfer.effectAllowed = 'move';
                                e.dataTransfer.setData('text/planner-task', t.id);
                              }}
                              onDragEnd={() => { setTaskDragId(null); setTaskDropCol(null); }}
                              onClick={(e) => { e.stopPropagation(); openTaskMenu(t.id, { x: e.clientX + 8, y: e.clientY }); }}
                              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openTaskMenu(t.id, { x: e.clientX, y: e.clientY }); }}
                              className="absolute rounded-lg overflow-hidden z-20 shadow-sm hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing"
                              style={{
                                top, height: h,
                                left:  `calc(${col * colW}% + ${EDGE + (col > 0 ? gapOffset : 0)}px)`,
                                right: `calc(${100 - (col + 1) * colW}% + ${EDGE + (col < numCols - 1 ? gapOffset : 0)}px)`,
                                background: c.bg,
                                // Dashed border + a solid left rail: the two cues that
                                // survive every card style, including `minimal`.
                                border: `1.5px dashed ${c.border}`,
                                borderLeft: `3px solid ${c.border}`,
                                opacity: taskDragId === t.id ? 0.4 : done ? 0.45 : 1,
                                filter: done ? 'saturate(0.4)' : 'none',
                              }}
                              title={`${t.title} — drag to top of day or another day`}
                            >
                              <div className="flex items-start gap-1 px-1.5 py-1">
                                <span
                                  role="button"
                                  tabIndex={-1}
                                  onClick={(e) => { e.stopPropagation(); handleToggleTaskDone(t.id); }}
                                  className="flex-shrink-0 mt-[1px]"
                                  style={{ color: c.text }}
                                >
                                  {done ? <CheckSquare size={11} /> : <Square size={11} />}
                                </span>
                                <span
                                  className="text-[11px] font-medium leading-tight break-words min-w-0"
                                  style={{ color: c.text, textDecoration: done ? 'line-through' : 'none' }}
                                >
                                  {t.title || 'Untitled task'}
                                </span>
                                {t.recur && <Repeat size={9} style={{ color: c.textMuted, flexShrink: 0, marginTop: 2 }} />}
                              </div>
                              {h >= 38 && (
                                <div className="px-1.5 text-[9.5px] tabular-nums" style={{ color: c.textMuted }}>
                                  {formatTimeLabel(startMin, timeFormat)}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}

                {/* All-Day Events Overlays (Continuous horizontal banners) */}
                {weekAllDayEvents.length > 0 && (() => {
                  const layoutMap = layoutAllDay(weekAllDayEvents);
                  return weekAllDayEvents.map(ev => {
                    const layoutInfo = layoutMap.get(ev.id);
                    if (!layoutInfo) return null;
                    const { row } = layoutInfo;
                    const startIdx = ev.visibleDayIndex;
                    const span = ev.visibleDaysSpan;
                    // Day view shows one column: clip the banner to that day, and
                    // skip it entirely when the span doesn't reach the shown day.
                    // Clip the banner to the visible column window (one column in day
                    // view, the custom range otherwise) and drop it if it misses.
                    const firstOff = visibleCols[0];
                    const clipStart = Math.max(startIdx, firstOff);
                    const clipEnd = Math.min(startIdx + span, firstOff + colCount);
                    if (clipEnd <= clipStart) return null;
                    const leftPct = ((clipStart - firstOff) / colCount) * 100;
                    const widthPct = ((clipEnd - clipStart) / colCount) * 100;

                    const isEdit = editingId === ev.id;
                    const isSelected = selectedIds.has(ev.id);
                    const isMenu = menuId === ev.id;
                    const { bg, border, text, textMuted } = chipColors(ev);

                    // Find actual day date string of start day
                    const startDayDate = dayAt(ev.visibleDayIndex ?? ev.dayIndex);
                    const dateStr = format(startDayDate, 'yyyy-MM-dd');
                    const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(dateStr) ?? false);

                    return (
                      <div
                        key={ev.id}
                        data-event="1"
                        data-event-id={ev.id}
                        className={`absolute rounded-md border text-[11px] font-semibold flex items-center gap-1.5 px-2.5 hover:-translate-y-[1.5px] ${isEdit || isMenu ? 'z-40 shadow-md' : 'z-10 shadow-sm hover:shadow-md'}`}
                        style={{
                          top: HEADER_PX + row * 28 + 4,
                          height: 24,
                          left: `calc(${leftPct}% + 4px)`,
                          width: `calc(${widthPct}% - 8px)`,
                          transition: 'top 260ms cubic-bezier(0.22,1,0.36,1), left 260ms cubic-bezier(0.22,1,0.36,1), width 260ms cubic-bezier(0.22,1,0.36,1), box-shadow 140ms ease, transform 140ms cubic-bezier(0.22,1,0.36,1), outline-color 140ms ease',
                          backgroundColor: bg,
                          borderColor: border,
                          color: text,
                          cursor: isEdit ? 'text' : 'pointer',
                          outline: isMenu ? `2px solid ${text}` : isSelected ? `2px solid ${darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.45)'}` : 'none',
                          outlineOffset: 1,
                        }}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (e.ctrlKey || e.metaKey) {
                            setSelectedIds(prev => { const n = new Set(prev); if (n.has(ev.id)) n.delete(ev.id); else n.add(ev.id); return n; });
                            return;
                          }
                          openMenu(e, ev);
                        }}
                        onDoubleClick={(e) => { e.stopPropagation(); openMenu(e, ev); enterEdit(ev.id); }}
                      >
                        {isEdit ? (
                          <input
                            autoFocus
                            type="text"
                            value={ev.content}
                            onChange={e => applyEdit(ev.id, { content: e.target.value })}
                            onKeyDown={e => {
                              if (e.key === 'Enter') { e.preventDefault(); finishEdit(); }
                              if (e.key === 'Escape') finishEdit();
                            }}
                            onBlur={() => finishEdit()}
                            onClick={e => e.stopPropagation()}
                            className="flex-1 bg-transparent outline-none text-[11px] leading-none p-0 w-full placeholder:opacity-40"
                            style={{ color: text }}
                            placeholder="All-day event..."
                          />
                        ) : (
                          <>
                            {!ev.noCheckbox && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleEventCompleted(ev.id, startDayDate);
                                }}
                                className="flex-shrink-0 w-3 h-3 rounded-full border transition-all duration-150 flex items-center justify-center cursor-pointer"
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
                          </>
                        )}
                      </div>
                    );
                  });
                })()}

                {/* Selection rectangle overlay (spans multiple days) */}
                {selRect && (
                  <div className="absolute pointer-events-none z-20" style={{
                    left: selRect.left,
                    top: topBandsHeight + selRect.top,
                    width: Math.max(2, selRect.width),
                    height: Math.max(2, selRect.height),
                    background: darkMode ? 'rgba(120,180,240,0.18)' : 'rgba(60,120,200,0.13)',
                    border: `1.5px solid ${darkMode ? 'rgba(120,180,240,0.40)' : 'rgba(60,120,200,0.30)'}`,
                    borderRadius: 6,
                  }}>
                    {/* Live start/end while drag-creating, pinned to each edge so
                        the exact times are readable before releasing the mouse. */}
                    {createDisp && (() => {
                      const chip = {
                        background: darkMode ? 'rgba(120,180,240,0.95)' : 'rgba(45,105,190,0.95)',
                        color: '#fff',
                        boxShadow: '0 2px 8px rgba(0,0,0,0.28)',
                      } as React.CSSProperties;
                      const dur = createDisp.endMin - createDisp.startMin;
                      const durLabel = dur >= 60
                        ? `${Math.floor(dur / 60)}h${dur % 60 ? ` ${dur % 60}m` : ''}`
                        : `${dur}m`;
                      return (
                        <>
                          <div className="absolute left-1/2 text-[10px] font-bold tabular-nums px-1.5 py-[2px] rounded whitespace-nowrap"
                               style={{ ...chip, top: -20, transform: 'translateX(-50%)' }}>
                            {formatTimeLabel(createDisp.startMin, timeFormat)}
                          </div>
                          <div className="absolute left-1/2 text-[10px] font-bold tabular-nums px-1.5 py-[2px] rounded whitespace-nowrap"
                               style={{ ...chip, bottom: -20, transform: 'translateX(-50%)' }}>
                            {formatTimeLabel(createDisp.endMin, timeFormat)}
                          </div>
                          {selRect.height >= 26 && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <span className="text-[10px] font-bold tabular-nums px-1.5 py-[1px] rounded"
                                    style={{ background: darkMode ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.75)', color: darkMode ? '#dbeafe' : '#1e40af' }}>
                                {durLabel}
                              </span>
                            </div>
                          )}
                        </>
                      );
                    })()}
                  </div>
                )}

                {/* Empty week hint — only once loading has settled, so it never
                    flashes over data that is still on its way in. */}
                <AnimatePresence>
                  {!eventsLoading && Object.keys(weekEvents).length === 0 && (
                    <motion.div
                      key="empty-week"
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3, delay: 0.1 }}
                      className="absolute left-1/2 z-20 pointer-events-none flex flex-col items-center gap-1.5 text-center px-6 py-5 rounded-xl"
                      style={{
                        top: topBandsHeight + 90,
                        transform: 'translateX(-50%)',
                        border: `1px dashed ${surfaceBdr}`,
                        background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.55)',
                      }}
                    >
                      <CalendarRange size={20} style={{ color: menuSub, opacity: 0.6 }} />
                      <span className="text-xs font-medium" style={{ color: menuText }}>Nothing planned this week</span>
                      <span className="text-[10px] leading-relaxed" style={{ color: menuSub }}>
                        Click a slot, or drag down a column, to block out time.
                      </span>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          </AnimatePresence>
        </motion.div>
        ) : calendarView === 'year' ? (
        /* â”€â”€ Year overview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
        (() => {
        const yearMaxDayCount = Math.max(1, ...yearMatrix.flatMap(m => m.cells.map(c => c.count)));
        return (
        <motion.div
          key="year-view-wrapper"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.08, ease: 'easeOut' }}
          className="rounded-xl border border-border/60 overflow-hidden shadow-md p-4 relative z-10"
          style={{ background: darkMode ? currentDarkTheme.cardBg : '#ffffff' }}
        >
          <div className="grid grid-cols-4 gap-3 items-start">
            {yearMatrix.map(m => (
              <button
                key={m.monthStart.toISOString()}
                onClick={() => { setDirection(0); setCurrentDate(m.monthStart); setCalendarView('month'); }}
                title={`Open ${format(m.monthStart, 'MMMM yyyy')}`}
                // self-start so months with 5 week-rows don't float vertically
                // centred next to months with 6.
                className="rounded-lg p-2.5 text-left transition-all duration-150 hover:-translate-y-[2px] self-start w-full"
                style={{
                  background: m.isCurrent ? (darkMode ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.06)') : surfaceBg,
                  border: `1px solid ${m.isCurrent ? 'rgba(96,165,250,0.45)' : surfaceBdr}`,
                }}
              >
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[11px] font-bold" style={{ color: m.isCurrent ? '#60a5fa' : menuText }}>
                    {format(m.monthStart, 'MMMM')}
                  </span>
                  {m.eventCount > 0 && (
                    <span className="text-[8.5px] font-semibold tabular-nums" style={{ color: menuSub }}>{m.eventCount}</span>
                  )}
                </div>
                {/* Weekday initials */}
                <div className="grid grid-cols-7 gap-[1px] mb-0.5">
                  {m.cells.slice(0, 7).map(c => (
                    <span key={c.date.toISOString()} className="text-[6.5px] font-bold uppercase text-center" style={{ color: menuSub, opacity: 0.7 }}>
                      {format(c.date, 'EEEEE')}
                    </span>
                  ))}
                </div>
                {/* Mini month grid: dot density = items that day */}
                <div className="grid grid-cols-7 gap-[1px]">
                  {m.cells.map(c => {
                    const dim = !isSameMonth(c.date, m.monthStart);
                    const isTodayCell = isSameDay(c.date, nowOwnerDate);
                    return (
                      <span
                        key={c.date.toISOString()}
                        className="aspect-square flex items-center justify-center rounded-[2px] text-[7px] tabular-nums relative"
                        style={{
                          color: isTodayCell ? '#fff' : dim ? menuSub : menuText,
                          opacity: dim ? 0.3 : 1,
                          // Scale against the busiest day of the year so the tint
                          // actually discriminates instead of saturating everywhere.
                          background: isTodayCell
                            ? '#60a5fa'
                            : c.count > 0
                              ? `rgba(96,165,250,${(0.07 + 0.33 * (c.count / yearMaxDayCount)).toFixed(3)})`
                              : 'transparent',
                        }}
                      >
                        {format(c.date, 'd')}
                      </span>
                    );
                  })}
                </div>
              </button>
            ))}
          </div>
        </motion.div>
        );
        })()
        ) : (
        /* â”€â”€ Month overview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
        <motion.div
          key="month-view-wrapper"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.08, ease: 'easeOut' }}
          className="rounded-xl border border-border/60 overflow-hidden shadow-md relative z-10"
          style={{ background: darkMode ? currentDarkTheme.cardBg : '#ffffff' }}
        >
            {/* Weekday header row */}
            <div className="grid grid-cols-7 border-b border-border/50">
              {(monthMatrix[0]?.cells ?? []).map(({ date }) => (
                <div key={date.toISOString()} className="py-2 text-center text-[10px] font-bold uppercase tracking-widest" style={{ color: headerLabel }}>
                  {format(date, 'EEE')}
                </div>
              ))}
            </div>
            {/* Week rows */}
            {monthMatrix.map(week => {
              const weekStartDate = parseDate(week.weekKey);
              const rawAllDays = Object.values(resolveWeek(events, week.weekKey)).filter(ev => ev.allDay && !ev.deleted);
              const weekAllDays: Array<PlannerEvent & { visibleDayIndex: number; visibleDaysSpan: number }> = [];
              for (const ev of rawAllDays) {
                const overlap = getEventWeekOverlap(ev, weekStartDate);
                if (overlap) {
                  weekAllDays.push({
                    ...ev,
                    visibleDayIndex: overlap.dayIndex,
                    visibleDaysSpan: overlap.daysSpan,
                  });
                }
              }
              const allDayLayoutMap = layoutAllDay(weekAllDays);
              let maxAllDayRow = -1;
              for (const info of allDayLayoutMap.values()) {
                if (info.row > maxAllDayRow) maxAllDayRow = info.row;
              }
              const allDayRowCount = maxAllDayRow + 1;

              return (
                <div key={week.weekKey} className="relative border-b border-border/40 last:border-b-0">
                  {/* 7 day cells in grid */}
                  <div className="grid grid-cols-7">
                    {week.cells.map(({ date, events: cellEvents }) => {
                      const inMonth = isSameMonth(date, currentDate);
                      const cellToday = isSameDay(date, nowOwnerDate);
                      const focusSecs = focusAnalysis.byDaySeconds.get(dateKey(date)) ?? 0;
                      const focusPct = focusSecs > 0 ? Math.min(1, focusSecs / Math.max(1, focusAnalysis.monthMaxSeconds)) : 0;
                      const baseBg = cellToday
                        ? (darkMode ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.06)')
                        : focusPct > 0
                          ? `rgba(96,165,250,${(0.05 + 0.16 * focusPct).toFixed(3)})`
                          : 'transparent';
                      const hoverCellBg = cellToday
                        ? (darkMode ? 'rgba(96,165,250,0.16)' : 'rgba(37,99,235,0.10)')
                        : hoverBg;
                      
                      // Timed events for this cell
                      const timedEvents = cellEvents.filter(e => !e.allDay);

                      return (
                        <div
                          key={date.toISOString()}
                          onClick={() => { setDirection(0); setCurrentDate(date); setCalendarView('week'); }}
                          title={focusSecs > 0 ? `Open this week · ${formatFocusDuration(focusSecs)} focused` : 'Open this week'}
                          className="min-h-[108px] p-1.5 border-r border-border/40 last:border-r-0 cursor-pointer flex flex-col gap-1 transition-colors duration-200 relative"
                          style={{ background: baseBg, opacity: inMonth ? 1 : 0.4 }}
                          onMouseEnter={e => (e.currentTarget.style.background = hoverCellBg)}
                          onMouseLeave={e => (e.currentTarget.style.background = baseBg)}
                        >
                          {cellToday && <span className="absolute left-0 top-0 bottom-0 w-[2.5px]" style={{ background: '#60a5fa' }} />}
                          <div className="flex items-center justify-between">
                            <span
                              className={`text-[11px] font-semibold tabular-nums ${cellToday ? 'flex items-center justify-center rounded-full w-[18px] h-[18px]' : ''}`}
                              style={cellToday
                                ? { background: '#60a5fa', color: '#fff' }
                                : { color: inMonth ? menuText : menuSub }}
                            >
                              {format(date, 'd')}
                            </span>
                            <span className="flex items-center gap-1">
                              {focusSecs > 0 && (
                                <span className="text-[8px] font-bold tabular-nums flex items-center gap-0.5" style={{ color: '#60a5fa' }} title={`${formatFocusDuration(focusSecs)} focused`}>
                                  <Target size={7} />{formatFocusDuration(focusSecs)}
                                </span>
                              )}
                              {(timedEvents.length > 0 || weekAllDays.length > 0) && (
                                <span className="text-[8.5px] tabular-nums" style={{ color: menuSub }}>
                                  {cellEvents.length}
                                </span>
                              )}
                            </span>
                          </div>

                          {/* Reserve vertical space for all-day banner rows */}
                          {allDayRowCount > 0 && (
                            <div style={{ height: allDayRowCount * 22 }} className="flex-shrink-0" />
                          )}

                          {/* Timed events list */}
                          <div className="flex flex-col gap-0.5 overflow-hidden">
                            {timedEvents.slice(0, 3).map(ev => {
                              const { bg, border, text } = chipColors(ev);
                              const label = formatTimeLabel(timeToMin(ev.startTime), timeFormat);
                              return (
                                <div
                                  key={ev.id}
                                  className="rounded px-1 py-0.5 truncate text-[9px] font-medium leading-tight transition-transform duration-150 hover:translate-x-[1px]"
                                  style={{
                                    background: bg,
                                    borderLeft: `2px solid ${border}`,
                                    color: text,
                                  }}
                                  title={`${label} ${ev.content}`}
                                >
                                  <span className="tabular-nums opacity-80">{label}</span>{ev.content ? ` ${ev.content}` : ''}
                                </div>
                              );
                            })}
                            {timedEvents.length > 3 && <span className="text-[8.5px] pl-1" style={{ color: menuSub }}>+{timedEvents.length - 3} more</span>}
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Continuous All-Day Banners Overlay for this week row */}
                  {weekAllDays.length > 0 && (
                    <div className="absolute left-0 right-0 top-[28px] pointer-events-none z-20">
                      {weekAllDays.map(ev => {
                        const layoutInfo = allDayLayoutMap.get(ev.id);
                        if (!layoutInfo) return null;
                        const { row } = layoutInfo;
                        const startIdx = ev.visibleDayIndex;
                        const span = ev.visibleDaysSpan;
                        const leftPct = (startIdx / 7) * 100;
                        const widthPct = (span / 7) * 100;
                        const { bg, border, text } = chipColors(ev);

                        const startDayDate = addDays(weekStartDate, startIdx);
                        const dateStr = format(startDayDate, 'yyyy-MM-dd');
                        const isCompleted = !ev.noCheckbox && (ev.completedDates?.includes(dateStr) ?? false);

                        return (
                          <div
                            key={ev.id}
                            data-event="1"
                            className="absolute rounded px-2 text-[10px] font-semibold flex items-center gap-1.5 pointer-events-auto hover:-translate-y-[1px] transition-transform shadow-sm cursor-pointer truncate"
                            style={{
                              top: row * 22,
                              height: 19,
                              left: `calc(${leftPct}% + 3px)`,
                              width: `calc(${widthPct}% - 6px)`,
                              backgroundColor: bg,
                              borderColor: border,
                              borderWidth: 1,
                              borderStyle: 'solid',
                              color: text,
                            }}
                            onClick={(e) => {
                              e.stopPropagation();
                              openMenu(e, ev);
                            }}
                            title={`All day: ${ev.content || 'Untitled'}`}
                          >
                            {!ev.noCheckbox && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleEventCompleted(ev.id, startDayDate);
                                }}
                                className="flex-shrink-0 w-2.5 h-2.5 rounded-full border transition-all flex items-center justify-center cursor-pointer"
                                style={{
                                  borderColor: isCompleted ? text : `${text}60`,
                                  backgroundColor: isCompleted ? text : 'transparent',
                                }}
                              >
                                {isCompleted && <div className="w-1 h-1 rounded-full" style={{ backgroundColor: bg }} />}
                              </button>
                            )}
                            <span className={`truncate flex-1 ${isCompleted ? 'line-through opacity-50' : ''}`} style={{ color: text }}>
                              {ev.content || <span style={{ opacity: 0.4, fontStyle: 'italic', fontWeight: 400 }}>Untitled</span>}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
      ) : (
        <motion.div
          key="focus-analysis-container"
          initial={{ opacity: 0, y: 15 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -15 }}
          transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
          className="min-w-[900px] max-w-[1400px] mx-auto p-4"
        >
            {/* All-time summary strip */}
            <div className="grid grid-cols-5 gap-3 mb-5">
              {[
                ['All-time', formatFocusDuration(focusAnalysis.allTimeSeconds), <Target size={13} key="i" />],
                ['Sessions Done', `${focusAnalysis.allTimeSessions}`, <CheckSquare size={13} key="i" />],
                ['Avg Session', formatFocusDuration(focusAnalysis.avgSessionLength), <BarChart3 size={13} key="i" />],
                ['Current Streak', `${focusAnalysis.currentStreak}d`, <Flame size={13} key="i" />],
                ['Best Streak', `${focusAnalysis.longestStreak}d`, <Award size={13} key="i" />],
              ].map(([label, value, icon]) => (
                <div key={label as string} className="rounded-xl px-3.5 py-3" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                  <div className="flex items-center gap-1.5 mb-1.5" style={{ color: menuSub }}>
                    {icon}
                    <span className="text-[9px] font-bold uppercase tracking-wider truncate">{label}</span>
                  </div>
                  <div className="text-lg font-semibold tabular-nums truncate" style={{ color: menuText }}>{value}</div>
                </div>
              ))}
            </div>

            <div className="rounded-xl overflow-hidden" style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.30)', border: `1px solid ${surfaceBdr}` }}>
              {/* Panel header: tab switcher */}
              <div className="flex items-center justify-between px-5 py-3" style={{ borderBottom: `1px solid ${surfaceBdr}` }}>
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-md flex items-center justify-center" style={{ background: darkMode ? 'rgba(96,165,250,0.16)' : 'rgba(37,99,235,0.10)', color: '#60a5fa' }}>
                    <BarChart3 size={14} />
                  </div>
                  <span className="text-sm font-semibold" style={{ color: menuText }}>
                    {analysisTab === 'week'
                      ? `${format(focusAnalysis.aWeekStart, 'MMM d')} – ${format(focusAnalysis.aWeekEnd, 'MMM d, yyyy')}`
                      : analysisTab === 'month'
                        ? format(analysisMonthCursor, 'MMMM yyyy')
                        : analysisYearCursor}
                  </span>
                </div>
                <div className="flex items-center gap-3">
                  {/* Day-start-hour setting — re-buckets all analysis live */}
                  <div className="flex items-center gap-2" title="The hour a new day begins for focus stats. Sessions before it count toward the previous day.">
                    <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: menuSub }}>Day starts</span>
                    <div className="flex items-center rounded-lg overflow-hidden" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                      <button
                        onClick={() => setFocusDayStartHour(h => (h + 23) % 24)}
                        className="px-2 py-1 flex items-center justify-center transition-colors"
                        style={{ color: menuSub }}
                        onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        title="Decrease day start hour"
                      >
                        <Minus size={12} />
                      </button>
                      <span className="px-2 py-1 text-[11px] font-semibold tabular-nums min-w-[52px] text-center" style={{ color: menuText }}>
                        {`${focusDayStartHour % 12 === 0 ? 12 : focusDayStartHour % 12} ${focusDayStartHour < 12 ? 'AM' : 'PM'}`}
                      </span>
                      <button
                        onClick={() => setFocusDayStartHour(h => (h + 1) % 24)}
                        className="px-2 py-1 flex items-center justify-center transition-colors"
                        style={{ color: menuSub }}
                        onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        title="Increase day start hour"
                      >
                        <Plus size={12} />
                      </button>
                    </div>
                  </div>

                  <div className="flex items-center rounded-lg p-0.5" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                    {(['week', 'month', 'year'] as const).map(tab => (
                      <button
                        key={tab}
                        onClick={() => setAnalysisTab(tab)}
                        className="px-3 py-1 rounded-md text-[11px] font-semibold capitalize transition-colors"
                        style={{
                          background: analysisTab === tab ? (darkMode ? 'rgba(96,165,250,0.20)' : '#ffffff') : 'transparent',
                          color: analysisTab === tab ? '#60a5fa' : menuSub,
                        }}
                      >
                        {tab}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="px-5 py-4">
                {analysisTab === 'week' ? (
                  <div>
                    {/* Week nav */}
                    <div className="flex items-center justify-between mb-3">
                      <button onClick={() => setAnalysisWeekCursor(d => subWeeks(d, 1))} className="p-1.5 rounded-md transition-colors" style={{ color: menuSub }} onMouseEnter={e => (e.currentTarget.style.background = hoverBg)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <ChevronLeft size={16} />
                      </button>
                      <button
                        onClick={() => setAnalysisWeekCursor(new Date())}
                        className="text-xs font-medium px-2 py-1 rounded-md transition-colors"
                        style={{ color: menuSub }}
                        onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                        title="Jump to this week"
                      >
                        Weekly overview
                      </button>
                      <button onClick={() => setAnalysisWeekCursor(d => addWeeks(d, 1))} className="p-1.5 rounded-md transition-colors" style={{ color: menuSub }} onMouseEnter={e => (e.currentTarget.style.background = hoverBg)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <ChevronRight size={16} />
                      </button>
                    </div>

                    {/* Week stats */}
                    <div className="grid grid-cols-4 gap-3 mb-4">
                      {[
                        ['Total', formatFocusDuration(weekAnalysisLive.seconds)],
                        ['Sessions', `${focusAnalysis.wkSessions}`],
                        ['Active Days', `${weekAnalysisLive.activeDays}`],
                        ['Avg / Active Day', formatFocusDuration(weekAnalysisLive.avgActive)],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <div className="text-[9px] font-bold uppercase tracking-widest truncate" style={{ color: menuSub }}>{label}</div>
                          <div className="text-sm font-semibold tabular-nums truncate" style={{ color: menuText }}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Per-day bars with the exact hours spelled out */}
                    <div className="flex items-end gap-2.5 h-44 mb-2">
                      {weekAnalysisLive.days.map(d => {
                        const pct = d.seconds > 0 ? Math.max(4, (d.seconds / weekAnalysisLive.maxSeconds) * 100) : 0;
                        const isTodayCol = isSameDay(d.date, nowOwnerDate);
                        const isBest = d.seconds > 0 && d.key === weekAnalysisLive.bestKey;
                        return (
                          <div key={d.key} className="flex-1 h-full flex flex-col justify-end gap-1 min-w-0">
                            {/* Exact time above each bar */}
                            <div
                              className="text-[10px] font-bold tabular-nums text-center truncate"
                              style={{ color: d.seconds > 0 ? (isTodayCol ? '#60a5fa' : menuText) : menuSub, opacity: d.seconds > 0 ? 1 : 0.5 }}
                            >
                              <span>{d.seconds > 0 ? formatFocusDuration(d.seconds) : '—'}</span>
                            </div>
                            <div className="flex-1 flex items-end">
                              <div
                                className="w-full rounded-t-md transition-all duration-300"
                                title={`${format(d.date, 'EEEE, MMM d')}: ${formatFocusDuration(d.seconds)}${d.sessions ? ` · ${d.sessions} session${d.sessions === 1 ? '' : 's'}` : ''}`}
                                style={{
                                  height: `${pct}%`,
                                  minHeight: d.seconds > 0 ? 3 : 0,
                                  background: isTodayCol ? '#60a5fa' : isBest ? 'rgba(96,165,250,0.65)' : darkMode ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)',
                                  border: `1px solid ${isTodayCol ? 'rgba(96,165,250,0.70)' : surfaceBdr}`,
                                }}
                              />
                            </div>
                            <div className="text-[9px] font-semibold text-center uppercase truncate" style={{ color: isTodayCol ? '#60a5fa' : menuSub }}>
                              {format(d.date, 'EEE')}
                            </div>
                            <div className="text-[8.5px] tabular-nums text-center truncate" style={{ color: menuSub }}>
                              {format(d.date, 'd')}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Exact per-day breakdown table (double-click row or duration to modify) */}
                    <div className="mt-4 rounded-xl overflow-hidden" style={{ border: `1px solid ${surfaceBdr}` }}>
                      {weekAnalysisLive.days.map((d, i) => (
                        <div
                          key={d.key}
                          onDoubleClick={() => startEditingFocusDay(d.key, d.date, d.seconds)}
                          className="flex items-center justify-between px-3.5 py-2.5 text-xs cursor-pointer select-none transition-colors hover:bg-blue-500/5"
                          style={{
                            background: isSameDay(d.date, nowOwnerDate)
                              ? (darkMode ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.06)')
                              : i % 2 === 0 ? surfaceBg : 'transparent',
                            borderTop: i === 0 ? 'none' : `1px solid ${surfaceBdr}`,
                          }}
                        >
                          <span className="font-medium flex items-center gap-1.5" style={{ color: isSameDay(d.date, nowOwnerDate) ? '#60a5fa' : menuText }}>
                            <Clock size={11} style={{ opacity: 0.5 }} />
                            {format(d.date, 'EEEE, MMM d')}
                            {isSameDay(d.date, nowOwnerDate) && <span className="text-[9px] font-bold uppercase tracking-wider">Today</span>}
                          </span>
                          <span
                            className="tabular-nums flex items-center gap-2"
                            style={{ color: d.seconds > 0 ? menuText : menuSub }}
                          >
                            {editingFocusDayKey === d.key ? (
                              <input
                                autoFocus
                                onFocus={e => e.target.select()}
                                value={editingFocusInput}
                                onChange={e => setEditingFocusInput(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    submitFocusDayEdit(d.key, d.date, d.seconds, e.currentTarget.value);
                                  }
                                  if (e.key === 'Escape') {
                                    submittingEditRef.current = true;
                                    setEditingFocusDayKey(null);
                                  }
                                }}
                                onBlur={e => submitFocusDayEdit(d.key, d.date, d.seconds, e.target.value)}
                                className="w-24 text-right text-xs font-bold bg-transparent border-b-2 outline-none"
                                style={{ color: menuText, borderColor: '#60a5fa' }}
                                onClick={e => e.stopPropagation()}
                              />
                            ) : (
                              <>
                                <span className="font-semibold">{formatFocusDuration(d.seconds)}</span>
                                <span style={{ color: menuSub }}> · {d.sessions} session{d.sessions === 1 ? '' : 's'}</span>
                              </>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>

                    {weekAnalysisLive.seconds === 0 && (
                      <div className="mt-4 rounded-xl px-4 py-6 flex flex-col items-center gap-1.5 text-center" style={{ border: `1px dashed ${surfaceBdr}` }}>
                        <Target size={18} style={{ color: menuSub, opacity: 0.6 }} />
                        <span className="text-xs font-medium" style={{ color: menuText }}>No focus logged this week</span>
                        <span className="text-[10px]" style={{ color: menuSub }}>Run the timer and each day's exact hours show up here.</span>
                      </div>
                    )}
                  </div>
                ) : analysisTab === 'month' ? (
                  <div>
                    {/* Month nav */}
                    <div className="flex items-center justify-between mb-3">
                      <button onClick={() => setAnalysisMonthCursor(d => subMonths(d, 1))} className="p-1.5 rounded-md transition-colors" style={{ color: menuSub }} onMouseEnter={e => (e.currentTarget.style.background = hoverBg)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <ChevronLeft size={16} />
                      </button>
                      <span className="text-xs font-medium" style={{ color: menuSub }}>Monthly overview</span>
                      <button onClick={() => setAnalysisMonthCursor(d => addMonths(d, 1))} className="p-1.5 rounded-md transition-colors" style={{ color: menuSub }} onMouseEnter={e => (e.currentTarget.style.background = hoverBg)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <ChevronRight size={16} />
                      </button>
                    </div>

                    {/* Month stats */}
                    <div className="grid grid-cols-4 gap-3 mb-4">
                      {[
                        ['Total', formatFocusDuration(focusAnalysis.monthSeconds + monthLiveExtraSeconds)],
                        ['Sessions', `${focusAnalysis.monthSessions}`],
                        ['Active Days', `${focusAnalysis.monthActiveDays}`],
                        ['Best Day', format(focusAnalysis.monthBestDay, 'MMM d')],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <div className="text-[9px] font-bold uppercase tracking-widest truncate" style={{ color: menuSub }}>{label}</div>
                          <div className="text-sm font-semibold tabular-nums truncate" style={{ color: menuText }}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* Weekday labels */}
                    <div className="grid grid-cols-7 gap-1.5 mb-1.5">
                      {focusAnalysis.monthGridDays.slice(0, 7).map(d => (
                        <div key={d.toISOString()} className="text-[9px] font-bold uppercase text-center tracking-wider" style={{ color: menuSub }}>
                          {format(d, 'EEEEE')}
                        </div>
                      ))}
                    </div>

                    {/* Calendar heatmap grid */}
                    <div className="grid grid-cols-7 gap-1.5">
                      {focusAnalysis.monthGridDays.map(d => {
                        const key = dateKey(d);
                        // Fold in the session that's running right now, same as the week tab.
                        const secs = (focusAnalysis.byDaySeconds.get(key) ?? 0)
                          + (activeFocusDayKey === key ? focusElapsedSeconds : 0);
                        const sessions = focusAnalysis.byDaySessions.get(key) ?? 0;
                        const inMonth = isSameMonth(d, analysisMonthCursor);
                        const intensity = secs > 0 ? Math.min(1, 0.18 + 0.82 * (secs / focusAnalysis.monthMaxSeconds)) : 0;
                        const todayCell = isSameDay(d, nowOwnerDate);
                        const hot = secs > focusAnalysis.monthMaxSeconds * 0.45;
                        return (
                          <div
                            key={key}
                            title={`${format(d, 'EEEE, MMM d')}: ${formatFocusDuration(secs)}${sessions ? ` · ${sessions} session${sessions === 1 ? '' : 's'}` : ''}`}
                            className="aspect-square rounded-md flex flex-col items-center justify-center gap-0.5 relative"
                            style={{
                              background: secs > 0 ? `rgba(96,165,250,${intensity})` : surfaceBg,
                              border: `1px solid ${todayCell ? '#60a5fa' : surfaceBdr}`,
                              opacity: inMonth ? 1 : 0.35,
                            }}
                          >
                            <span className="text-[17px] font-semibold tabular-nums leading-none" style={{ color: hot ? '#fff' : menuText }}>
                              {format(d, 'd')}
                            </span>
                            {/* Exact time for this day, always visible — not just in the tooltip. */}
                            <span
                              onDoubleClick={(e) => {
                                e.stopPropagation();
                                startEditingFocusDay(key, d, secs);
                              }}
                              className="text-[15px] font-bold tabular-nums leading-none cursor-pointer"
                              style={{ color: secs > 0 ? (hot ? '#fff' : '#60a5fa') : menuSub, opacity: secs > 0 ? 1 : 0.45 }}
                            >
                              {editingFocusDayKey === key ? (
                                <input
                                  autoFocus
                                  onFocus={e => e.target.select()}
                                  value={editingFocusInput}
                                  onChange={e => setEditingFocusInput(e.target.value)}
                                  onKeyDown={e => {
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      submitFocusDayEdit(key, d, secs, e.currentTarget.value);
                                    }
                                    if (e.key === 'Escape') {
                                      submittingEditRef.current = true;
                                      setEditingFocusDayKey(null);
                                    }
                                  }}
                                  onBlur={e => submitFocusDayEdit(key, d, secs, e.target.value)}
                                  className="w-14 text-center text-xs font-bold bg-transparent border-b outline-none"
                                  style={{ color: hot ? '#fff' : menuText, borderColor: '#60a5fa' }}
                                  onClick={e => e.stopPropagation()}
                                />
                              ) : (
                                <span>{secs > 0 ? formatFocusDuration(secs) : '—'}</span>
                              )}
                            </span>
                            {sessions > 0 && (
                              <span className="text-[11px] font-bold tabular-nums leading-none" style={{ color: hot ? 'rgba(255,255,255,0.9)' : menuSub }}>
                                {sessions}×
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                    {focusAnalysis.monthSessions === 0 && (
                      <div className="mt-4 rounded-xl px-4 py-6 flex flex-col items-center gap-1.5 text-center" style={{ border: `1px dashed ${surfaceBdr}` }}>
                        <Target size={18} style={{ color: menuSub, opacity: 0.6 }} />
                        <span className="text-xs font-medium" style={{ color: menuText }}>No focus sessions in {format(analysisMonthCursor, 'MMMM')}</span>
                        <span className="text-[10px]" style={{ color: menuSub }}>Start the timer on the calendar and your days will light up here.</span>
                      </div>
                    )}
                  </div>
                ) : (
                  <div>
                    {/* Year nav */}
                    <div className="flex items-center justify-between mb-3">
                      <button onClick={() => setAnalysisYearCursor(y => y - 1)} className="p-1.5 rounded-md transition-colors" style={{ color: menuSub }} onMouseEnter={e => (e.currentTarget.style.background = hoverBg)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <ChevronLeft size={16} />
                      </button>
                      <span className="text-xs font-medium" style={{ color: menuSub }}>Yearly overview</span>
                      <button onClick={() => setAnalysisYearCursor(y => y + 1)} className="p-1.5 rounded-md transition-colors" style={{ color: menuSub }} onMouseEnter={e => (e.currentTarget.style.background = hoverBg)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                        <ChevronRight size={16} />
                      </button>
                    </div>

                    {/* Year stats */}
                    <div className="grid grid-cols-4 gap-3 mb-5">
                      {[
                        ['Total', formatFocusDuration(focusAnalysis.yearSeconds)],
                        ['Sessions', `${focusAnalysis.yearSessions}`],
                        ['Active Days', `${focusAnalysis.yearActiveDays}`],
                        ['Best Month', format(focusAnalysis.yearBestMonth.month, 'MMM')],
                      ].map(([label, value]) => (
                        <div key={label} className="min-w-0">
                          <div className="text-[9px] font-bold uppercase tracking-widest truncate" style={{ color: menuSub }}>{label}</div>
                          <div className="text-sm font-semibold tabular-nums truncate" style={{ color: menuText }}>{value}</div>
                        </div>
                      ))}
                    </div>

                    {/* 12-month bar chart */}
                    <div className="flex items-end gap-2.5 h-40">
                      {focusAnalysis.monthTotals.map(m => {
                        const pct = Math.max(3, (m.seconds / focusAnalysis.yearMaxSeconds) * 100);
                        const active = isSameMonth(m.month, nowDate) && analysisYearCursor === nowDate.getFullYear();
                        return (
                          <div key={m.month.toISOString()} className="flex-1 h-full flex flex-col justify-end gap-1.5 min-w-0">
                            <div className="flex-1 flex items-end">
                              <div
                                className="w-full rounded-t-md transition-all duration-300"
                                title={`${format(m.month, 'MMMM')}: ${formatFocusDuration(m.seconds)} · ${m.sessions} session${m.sessions === 1 ? '' : 's'}`}
                                style={{
                                  height: `${pct}%`,
                                  background: active ? '#60a5fa' : darkMode ? 'rgba(255,255,255,0.24)' : 'rgba(0,0,0,0.18)',
                                  border: `1px solid ${active ? 'rgba(96,165,250,0.70)' : surfaceBdr}`,
                                }}
                              />
                            </div>
                            <div className="text-[9px] font-semibold text-center uppercase truncate" style={{ color: active ? '#60a5fa' : menuSub }}>
                              {format(m.month, 'MMM')}
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Monthly breakdown table */}
                    <div className="mt-5 rounded-xl overflow-hidden" style={{ border: `1px solid ${surfaceBdr}` }}>
                      {focusAnalysis.monthTotals.filter(m => m.seconds > 0 || m.sessions > 0).length === 0 ? (
                        <div className="px-4 py-6 text-center text-xs" style={{ color: menuSub }}>No focus sessions logged in {analysisYearCursor}.</div>
                      ) : (
                        focusAnalysis.monthTotals.map((m, i) => (
                          <div
                            key={m.month.toISOString()}
                            className="flex items-center justify-between px-3.5 py-2 text-xs"
                            style={{ background: i % 2 === 0 ? surfaceBg : 'transparent', borderTop: i === 0 ? 'none' : `1px solid ${surfaceBdr}` }}
                          >
                            <span className="font-medium flex items-center gap-1.5" style={{ color: menuText }}>
                              <TrendingUp size={11} style={{ opacity: 0.5 }} />
                              {format(m.month, 'MMMM')}
                            </span>
                            <span className="tabular-nums" style={{ color: menuSub }}>
                              {formatFocusDuration(m.seconds)} · {m.sessions} session{m.sessions === 1 ? '' : 's'} · {m.activeDays} active day{m.activeDays === 1 ? '' : 's'}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </main>
          {/* Floating "Go to Live" button — centered on the main schedule table */}
          <AnimatePresence>
            {showLiveBtn && isTimelineView && !settingsRouteOpen && (
              <div className="absolute bottom-6 left-0 right-0 z-[120] pointer-events-none flex justify-center">
                <div className="min-w-[900px] max-w-[1400px] w-full mx-auto px-4 flex justify-center pointer-events-none">
                  <motion.button
                    key="go-to-live"
                    onClick={scrollToLive}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 12 }}
                    transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
                    className="pointer-events-auto flex items-center gap-1.5 px-4 py-2.5 rounded-full text-xs font-semibold shadow-lg backdrop-blur-md active:scale-95 cursor-pointer"
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
                  </motion.button>
                </div>
              </div>
            )}
          </AnimatePresence>
        </div>

        <TasksPanel
          open={tasksPanelOpen && !showFocusAnalysis}
          width={tasksPanelWidth}
          tasks={tasks}
          filters={taskFilters}
          timeFormat={timeFormat}
          weekStartsOn={weekStartsOn}
          taskColor={taskColor}
          taskCheckboxShape={taskCheckboxShape}
          theme={taskPanelTheme}
          onFiltersChange={setTaskFilters}
          onCreate={createTask}
          onToggleDone={handleToggleTaskDone}
          onEdit={editTask}
          onDelete={deleteTask}
          onOpenMenu={openTaskMenu}
          onResize={(w: number) => setTasksPanelWidth(clampPanelWidth(w))}
          onClose={() => setTasksPanelOpen(false)}
        />
      </div>

      {/* Focus Day Edit Confirmation Modal */}
      {confirmFocusModal && createPortal(
        <div
          className="fixed inset-0 z-[99999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.65)', backdropFilter: 'blur(4px)' }}
          onClick={() => setConfirmFocusModal(null)}
        >
          <div
            className="w-full max-w-md rounded-2xl p-6 border shadow-2xl relative animate-in fade-in zoom-in-95 duration-150"
            style={{ background: darkMode ? '#18181b' : '#ffffff', borderColor: darkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)', color: darkMode ? '#ffffff' : '#09090b' }}
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-blue-500/10 text-blue-400">
                <Clock size={20} />
              </div>
              <div>
                <h3 className="text-base font-semibold">Modify Focus Time</h3>
                <p className="text-xs" style={{ color: darkMode ? '#a1a1aa' : '#71717a' }}>{confirmFocusModal.label}</p>
              </div>
            </div>

            <div className="rounded-xl p-3.5 mb-4 space-y-2.5 border" style={{ background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)', borderColor: darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.10)' }}>
              <div className="flex items-center justify-between text-xs font-medium">
                <span style={{ color: darkMode ? '#a1a1aa' : '#71717a' }}>Previous value:</span>
                <span className="tabular-nums font-semibold text-right">
                  {formatDetailedDuration(confirmFocusModal.oldSeconds)}
                </span>
              </div>
              <div className="flex items-center justify-between text-xs font-medium">
                <span style={{ color: darkMode ? '#a1a1aa' : '#71717a' }}>New value:</span>
                <span className="tabular-nums font-bold text-blue-400 text-right">
                  {formatDetailedDuration(confirmFocusModal.newSeconds)}
                </span>
              </div>
            </div>

            <div className="rounded-xl p-3 mb-5 border border-amber-500/30 bg-amber-500/10 text-amber-400 text-xs flex items-start gap-2.5">
              <AlertTriangle size={16} className="flex-shrink-0 mt-0.5 text-amber-400" />
              <div>
                <span className="font-semibold block mb-0.5">Permanent Database Action</span>
                This action directly updates your focus-sessions.json database for this specific day. This change cannot be undone.
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setConfirmFocusModal(null)}
                className="px-4 py-2 rounded-xl text-xs font-semibold transition-colors cursor-pointer"
                style={{ background: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: darkMode ? '#ffffff' : '#09090b' }}
              >
                Cancel
              </button>
              <button
                type="button"
                autoFocus
                onClick={() => {
                  commitFocusDayDuration(confirmFocusModal.dateKey, confirmFocusModal.date, confirmFocusModal.newSeconds);
                  setConfirmFocusModal(null);
                }}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 hover:bg-blue-500 text-white shadow-md transition-colors cursor-pointer"
              >
                Confirm & Save
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* â”€â”€ Keyboard shortcut help overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <AnimatePresence>
        {showShortcutHelp && (
          <>
            <motion.div
              key="shortcut-help-backdrop"
              initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              onClick={() => setShowShortcutHelp(false)}
              className="fixed inset-0 z-[280] backdrop-blur-[6px]"
              style={{ background: darkMode ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.25)' }}
            />
            {/* Flex-centred wrapper: framer-motion drives `transform` on the panel
                itself, so centring must not rely on a transform of our own. */}
            <div
              key="shortcut-help-wrap"
              className="fixed inset-0 z-[290] flex items-center justify-center p-4 pointer-events-none"
            >
            <motion.div
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 8 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="pointer-events-auto w-[560px] max-w-[92vw] max-h-[80vh] overflow-y-auto rounded-2xl"
              style={{
                background: menuBg,
                border: `1px solid ${menuBdr}`,
                boxShadow: `0 24px 64px rgba(0,0,0,${darkMode ? 0.6 : 0.20})`,
              }}
            >
              <div className="flex items-center justify-between px-5 py-3.5 sticky top-0" style={{ borderBottom: `1px solid ${menuBdr}`, background: menuBg }}>
                <span className="text-sm font-semibold" style={{ color: menuText }}>Keyboard Shortcuts</span>
                <button onClick={() => setShowShortcutHelp(false)} className="p-1 rounded-md" style={{ color: menuSub }}>
                  <X size={15} />
                </button>
              </div>
              <div className="px-5 py-4 grid grid-cols-2 gap-x-6 gap-y-5">
                {(['Navigation', 'View', 'Editing', 'Focus'] as const).map(group => (
                  <div key={group} className="flex flex-col gap-1.5">
                    <span className="text-[9px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>{group}</span>
                    {SHORTCUT_DEFS.filter(d => d.group === group).map(def => (
                      <div key={def.action} className="flex items-center justify-between gap-3">
                        <span className="text-[11.5px] truncate" style={{ color: menuText }}>{def.label}</span>
                        <kbd
                          className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap flex-shrink-0"
                          style={{ background: hoverBg, border: `1px solid ${menuBdr}`, color: menuText, fontFamily: 'inherit' }}
                        >
                          {formatCombo(shortcuts[def.action])}
                        </kbd>
                      </div>
                    ))}
                  </div>
                ))}
                <div className="col-span-2 pt-1 text-[10px] leading-relaxed" style={{ color: menuSub, borderTop: `1px solid ${menuBdr}` }}>
                  <span className="block pt-2.5">
                    Rebind any of these in <span style={{ color: menuText }}>Settings â†’ Keyboard Shortcuts</span>.
                    Always available: <kbd style={{ color: menuText }}>Esc</kbd> to close, <kbd style={{ color: menuText }}>Ctrl + drag</kbd> to box-select,
                    <kbd style={{ color: menuText }}> drag empty space</kbd> to create.
                  </span>
                </div>
              </div>
            </motion.div>
            </div>
          </>
        )}
      </AnimatePresence>

      {/* â”€â”€ Toasts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <div className="fixed bottom-5 right-5 z-[300] flex flex-col gap-2 items-end pointer-events-none">
        <AnimatePresence initial={false}>
          {toasts.map(t => {
            const tone = t.tone === 'success'
              ? { accent: '#4ade80', glow: 'rgba(74,222,128,0.30)' }
              : t.tone === 'error'
                ? { accent: '#f87171', glow: 'rgba(248,113,113,0.30)' }
                : { accent: '#60a5fa', glow: 'rgba(96,165,250,0.30)' };
            return (
              <motion.div
                key={t.id}
                layout
                initial={{ opacity: 0, x: 24, scale: 0.96 }}
                animate={{ opacity: 1, x: 0, scale: 1 }}
                exit={{ opacity: 0, x: 24, scale: 0.96 }}
                transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
                className="pointer-events-auto flex items-center gap-2.5 pl-3 pr-4 py-2.5 rounded-xl text-[12px] font-medium max-w-[340px] backdrop-blur-md"
                style={{
                  background: darkMode ? 'rgba(30,32,34,0.92)' : 'rgba(255,255,255,0.94)',
                  border: `1px solid ${menuBdr}`,
                  color: menuText,
                  boxShadow: `0 8px 28px rgba(0,0,0,${darkMode ? 0.45 : 0.14}), 0 0 0 1px ${tone.glow}`,
                }}
              >
                <span className="w-1 self-stretch rounded-full flex-shrink-0" style={{ background: tone.accent }} />
                <span className="leading-snug">{t.message}</span>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>



      {/* â”€â”€ Settings drawer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <AnimatePresence>
        {settingsOpen && (
          <>
            {/* Backdrop with blur */}
            <motion.div
              key="settings-backdrop"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              onClick={() => setSettingsOpen(false)}
              className="fixed inset-0 top-14 z-[140] backdrop-blur-[6px]"
              style={{
                background: darkMode ? 'rgba(0, 0, 0, 0.45)' : 'rgba(0, 0, 0, 0.15)',
              }}
            />

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

              {/* Session-complete sound */}
              <hr className="border-t opacity-10" style={{ borderColor: surfaceBdr }} />
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>When The Session Ends</span>
                  <button
                    type="button"
                    onClick={() => playFocusChime(focusChime)}
                    className="text-[10px] font-semibold px-2 py-1 rounded-md transition-colors"
                    style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText }}
                    onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                    onMouseLeave={e => (e.currentTarget.style.background = surfaceBg)}
                  >
                    Play
                  </button>
                </div>
                <div className="flex flex-col gap-1.5">
                  {FOCUS_CHIMES.map(c => {
                    const active = focusChime === c.id;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        // Selecting also previews it — comparing them is the point.
                        onClick={() => { setFocusChime(c.id); playFocusChime(c.id); }}
                        className="flex items-center justify-between gap-3 text-left px-2.5 py-2 rounded-lg transition-colors"
                        style={{
                          background: active ? (darkMode ? 'rgba(96,165,250,0.16)' : 'rgba(37,99,235,0.09)') : surfaceBg,
                          border: `1px solid ${active ? 'rgba(96,165,250,0.55)' : surfaceBdr}`,
                        }}
                        onMouseEnter={e => { if (!active) e.currentTarget.style.background = hoverBg; }}
                        onMouseLeave={e => { if (!active) e.currentTarget.style.background = surfaceBg; }}
                      >
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold truncate" style={{ color: active ? '#60a5fa' : menuText }}>{c.label}</span>
                          <span className="block text-[10px] leading-snug" style={{ color: menuSub }}>{c.hint}</span>
                        </span>
                        <Volume2 size={13} style={{ color: active ? '#60a5fa' : menuSub, flexShrink: 0 }} />
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Start / pause / resume cues */}
              <hr className="border-t opacity-10" style={{ borderColor: surfaceBdr }} />
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Timer Cues</span>
                {([
                  { slot: 'start' as FocusCueSlot,  label: 'When the timer starts' },
                  { slot: 'pause' as FocusCueSlot,  label: 'When it is paused or stopped' },
                  { slot: 'resume' as FocusCueSlot, label: 'When it resumes' },
                ]).map(({ slot, label }) => (
                  <div key={slot} className="flex flex-col gap-1">
                    <span className="text-[10px]" style={{ color: menuSub }}>{label}</span>
                    <div className="flex flex-wrap gap-1">
                      {FOCUS_CUES.map(c => {
                        const active = focusCues[slot] === c.id;
                        return (
                          <button
                            key={c.id}
                            type="button"
                            title={c.hint}
                            // Selecting also previews it — comparing them is the point.
                            onClick={() => { setFocusCues(prev => ({ ...prev, [slot]: c.id })); playFocusCue(c.id); }}
                            className="text-[10px] font-semibold px-2 py-1 rounded-md transition-colors"
                            style={{
                              background: active ? (darkMode ? 'rgba(96,165,250,0.16)' : 'rgba(37,99,235,0.09)') : surfaceBg,
                              border: `1px solid ${active ? 'rgba(96,165,250,0.55)' : surfaceBdr}`,
                              color: active ? '#60a5fa' : menuText,
                            }}
                          >
                            {c.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>

              {/* Keyboard shortcuts */}
              <hr className="border-t opacity-10" style={{ borderColor: surfaceBdr }} />
              <div className="flex flex-col gap-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Keyboard Shortcuts</span>
                  <button
                    onClick={() => setShortcuts({ ...DEFAULT_SHORTCUTS })}
                    className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded"
                    style={{ color: menuSub, border: `1px solid ${surfaceBdr}` }}
                    title="Restore every shortcut to its default"
                  >
                    Reset all
                  </button>
                </div>
                <p className="text-[10px] leading-relaxed" style={{ color: menuSub }}>
                  Click a shortcut, then press the keys you want. Esc cancels.
                </p>
                {(['Navigation', 'View', 'Editing', 'Focus'] as const).map(group => (
                  <div key={group} className="flex flex-col gap-1">
                    <span className="text-[9px] font-bold uppercase tracking-wider mt-1" style={{ color: menuSub, opacity: 0.75 }}>{group}</span>
                    {SHORTCUT_DEFS.filter(d => d.group === group).map(def => {
                      const recording = recordingAction === def.action;
                      const conflicts = findConflicts(shortcuts, def.action);
                      return (
                        <button
                          key={def.action}
                          // detail === 0 means the "click" came from Enter/Space on a
                          // focused button — that must not silently arm the recorder
                          // and swallow the user's next keystroke as a binding.
                          onClick={(e) => { if (e.detail === 0) return; setRecordingAction(recording ? null : def.action); }}
                          title={def.hint}
                          className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left transition-colors"
                          style={{
                            background: recording ? (darkMode ? 'rgba(96,165,250,0.16)' : 'rgba(37,99,235,0.09)') : 'transparent',
                            border: `1px solid ${recording ? 'rgba(96,165,250,0.45)' : 'transparent'}`,
                          }}
                          onMouseEnter={e => { if (!recording) e.currentTarget.style.background = hoverBg; }}
                          onMouseLeave={e => { if (!recording) e.currentTarget.style.background = 'transparent'; }}
                        >
                          <span className="text-[11px] font-medium truncate" style={{ color: menuText }}>{def.label}</span>
                          <kbd
                            className="text-[9.5px] font-semibold px-1.5 py-0.5 rounded whitespace-nowrap flex-shrink-0"
                            style={{
                              background: surfaceBg,
                              border: `1px solid ${conflicts.length ? 'rgba(248,113,113,0.55)' : surfaceBdr}`,
                              color: recording ? '#60a5fa' : conflicts.length ? '#f87171' : menuText,
                              fontFamily: 'inherit',
                            }}
                          >
                            {recording ? 'Press keys…' : formatCombo(shortcuts[def.action])}
                          </kbd>
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* Automatic backup */}
              <hr className="border-t opacity-10" style={{ borderColor: surfaceBdr }} />
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Automatic Backup</span>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium" style={{ color: menuText }}>Enabled</span>
                  <button
                    onClick={() => setAutoBackup(c => ({ ...c, enabled: !c.enabled }))}
                    className="relative flex-shrink-0 rounded-full transition-colors duration-200"
                    style={{
                      width: 36, height: 20,
                      background: autoBackup.enabled ? 'rgba(120,200,120,0.55)' : surfaceBdr,
                      border: `1px solid ${surfaceBdr}`,
                    }}
                  >
                    <span
                      className="absolute rounded-full transition-transform duration-200"
                      style={{
                        width: 15, height: 15, top: 2, left: 2,
                        background: autoBackup.enabled ? '#fff' : menuSub,
                        transform: autoBackup.enabled ? 'translateX(17px)' : 'translateX(0px)',
                      }}
                    />
                  </button>
                </div>

                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-medium" style={{ color: menuSub }}>Run every</span>
                  <select
                    value={autoBackup.intervalHours}
                    onChange={e => setAutoBackup(c => ({ ...c, intervalHours: parseInt(e.target.value) }))}
                    disabled={!autoBackup.enabled}
                    className="w-full py-1.5 px-2 text-xs font-medium rounded-md transition-all duration-200"
                    style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText, outline: 'none', opacity: autoBackup.enabled ? 1 : 0.45 }}
                  >
                    {[
                      [1, 'Hour'], [3, '3 hours'], [6, '6 hours'], [12, '12 hours'],
                      [24, 'Day'], [72, '3 days'], [168, 'Week'],
                    ].map(([h, label]) => (
                      <option key={h as number} value={h as number}>{label as string}</option>
                    ))}
                  </select>
                </div>

                <div className="flex flex-col gap-0.5">
                  <span className="text-[9px] font-medium" style={{ color: menuSub }}>Keep the last</span>
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={autoBackup.keep}
                      onChange={e => setAutoBackup(c => ({ ...c, keep: Math.max(1, Math.min(1000, parseInt(e.target.value) || 1)) }))}
                      className="flex-1 py-1.5 px-2 text-xs font-medium tabular-nums rounded-md outline-none"
                      style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText }}
                    />
                    <span className="text-[10px]" style={{ color: menuSub }}>backups</span>
                  </div>
                </div>

                <button
                  onClick={runBackupNow}
                  className="w-full py-2 px-3 text-xs font-semibold rounded-md text-center transition-all duration-200"
                  style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText }}
                  onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                  onMouseLeave={e => (e.currentTarget.style.background = surfaceBg)}
                >
                  Back Up Now
                </button>
                <p className="text-[10px] leading-relaxed" style={{ color: menuSub }}>
                  Saved to the <span style={{ color: menuText }}>backups</span> folder.
                  {backupStatus
                    ? ` ${backupStatus.count} stored${backupStatus.lastBackupAt ? ` · last ${format(new Date(backupStatus.lastBackupAt), 'MMM d, HH:mm')}` : ''}.`
                    : ''}
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

              {/* Google Calendar Sync */}
              <hr className="border-t opacity-10" style={{ borderColor: surfaceBdr }} />
              <div className="flex flex-col gap-2.5">
                <span className="text-[10px] font-bold uppercase tracking-widest" style={{ color: menuSub }}>Google Calendar Sync</span>
                
                {!gCalStatus.configured ? (
                  <div className="flex flex-col gap-2">
                    <p className="text-[10px] leading-relaxed" style={{ color: menuSub }}>
                      Configure your OAuth 2.0 client credentials to hook up Google Calendar.
                    </p>
                    <div className="flex flex-col gap-1.5">
                      <input
                        type="text"
                        placeholder="Client ID"
                        value={clientIdInput}
                        onChange={e => setClientIdInput(e.target.value)}
                        className="w-full py-1.5 px-2.5 text-xs rounded-md border outline-none transition-colors"
                        style={{
                          background: surfaceBg,
                          borderColor: surfaceBdr,
                          color: menuText
                        }}
                      />
                      <input
                        type="password"
                        placeholder="Client Secret"
                        value={clientSecretInput}
                        onChange={e => setClientSecretInput(e.target.value)}
                        className="w-full py-1.5 px-2.5 text-xs rounded-md border outline-none transition-colors"
                        style={{
                          background: surfaceBg,
                          borderColor: surfaceBdr,
                          color: menuText
                        }}
                      />
                      <button
                        onClick={() => {
                          if (!clientIdInput || !clientSecretInput) return;
                          fetch('/api/google-auth/setup', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ clientId: clientIdInput, clientSecret: clientSecretInput, autoSync: true })
                          })
                          .then(r => r.json())
                          .then(res => {
                            if (res.success) {
                              setGCalStatus(prev => ({ ...prev, configured: true, autoSync: true }));
                            }
                          });
                        }}
                        disabled={!clientIdInput || !clientSecretInput}
                        className="w-full py-1.5 px-3 text-xs font-semibold rounded-md text-center transition-all duration-200"
                        style={{
                          background: (clientIdInput && clientSecretInput) ? '#4a90e2' : surfaceBg,
                          borderColor: surfaceBdr,
                          color: (clientIdInput && clientSecretInput) ? '#fff' : menuSub,
                          cursor: (clientIdInput && clientSecretInput) ? 'pointer' : 'not-allowed'
                        }}
                      >
                        Save Credentials
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col gap-2.5">
                    <div className="flex items-center justify-between p-2 rounded-md" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                      <div className="flex flex-col gap-0.5">
                        <span className="text-[10px] font-semibold" style={{ color: menuText }}>
                          {gCalStatus.authenticated ? 'Connected' : 'Credentials Configured'}
                        </span>
                        {gCalStatus.email && (
                          <span className="text-[9px]" style={{ color: menuSub }}>
                            {gCalStatus.email}
                          </span>
                        )}
                      </div>
                      <span className="flex h-2 w-2 relative">
                        <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${gCalStatus.authenticated ? 'bg-green-400' : 'bg-yellow-400'}`}></span>
                        <span className={`relative inline-flex rounded-full h-2 w-2 ${gCalStatus.authenticated ? 'bg-green-500' : 'bg-yellow-500'}`}></span>
                      </span>
                    </div>

                    {/* What the connection is actually doing. Without this the only
                        signal was a spinner, which spun just as happily when every
                        call was failing. */}
                    <div className="flex flex-col gap-0.5 pb-1">
                      {gCalStatus.needsReconnect && gCalStatus.authError && (
                        <span className="text-[10px] leading-snug" style={{ color: '#f87171' }}>
                          {gCalStatus.authError}
                        </span>
                      )}
                      <span className="text-[10px]" style={{ color: menuSub }}>
                        {syncHealthLabel('Calendar', gCalHealth?.calendar)}
                      </span>
                      <span className="text-[10px]" style={{ color: menuSub }}>
                        {syncHealthLabel('Tasks', gCalHealth?.tasks)}
                      </span>
                    </div>

                    {!gCalStatus.authenticated ? (
                      <button
                        onClick={() => {
                          const redirectUri = window.location.origin;
                          fetch(`/api/google-auth/url?redirectUri=${encodeURIComponent(redirectUri)}`)
                            .then(r => r.json())
                            .then(res => {
                              if (res.url) {
                                window.location.href = res.url;
                              }
                            });
                        }}
                        className="w-full py-1.5 px-3 text-xs font-semibold rounded-md text-center transition-all text-white bg-blue-500 hover:bg-blue-600 cursor-pointer"
                      >
                        {gCalStatus.needsReconnect ? 'Reconnect Google Account' : 'Link Google Account'}
                      </button>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center justify-between py-1">
                          <span className="text-xs font-medium" style={{ color: menuText }}>Auto-Sync (5m)</span>
                          <button
                            onClick={() => {
                              const newAuto = !gCalStatus.autoSync;
                              fetch('/api/google-auth/setup', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ clientId: gCalStatus.clientId, clientSecret: gCalStatus.clientSecret, autoSync: newAuto })
                              })
                              .then(r => r.json())
                              .then(res => {
                                if (res.success) {
                                  setGCalStatus(prev => ({ ...prev, autoSync: newAuto }));
                                }
                              });
                            }}
                            className="relative flex-shrink-0 rounded-full transition-colors duration-200"
                            style={{
                              width: 36, height: 20,
                              background: gCalStatus.autoSync ? 'rgba(120,200,120,0.55)' : surfaceBdr,
                              border: `1px solid ${surfaceBdr}`,
                            }}
                          >
                            <span
                              className="absolute rounded-full transition-transform duration-200"
                              style={{
                                width: 15, height: 15, top: 2, left: 2,
                                background: gCalStatus.autoSync ? '#fff' : menuSub,
                                transform: gCalStatus.autoSync ? 'translateX(17px)' : 'translateX(0px)',
                              }}
                            />
                          </button>
                        </div>

                        <button
                          onClick={() => triggerGCalSync()}
                          disabled={gCalSyncing}
                          className="w-full py-1.5 px-3 text-xs font-semibold rounded-md text-center transition-all duration-200"
                          style={{
                            background: surfaceBg,
                            border: `1px solid ${surfaceBdr}`,
                            color: menuText,
                            cursor: gCalSyncing ? 'not-allowed' : 'pointer'
                          }}
                        >
                          {gCalSyncing ? 'Syncing...' : 'Sync Now'}
                        </button>

                        <div className="flex gap-1.5 mt-1">
                          <button
                            onClick={() => {
                              fetch('/api/google-auth/disconnect', { method: 'POST' })
                                .then(r => r.json())
                                .then(res => {
                                  if (res.success) {
                                    setGCalStatus(prev => ({ ...prev, authenticated: false, email: undefined }));
                                  }
                                });
                            }}
                            className="flex-1 py-1 px-2 text-[10px] rounded-md transition-all border text-red-500 hover:bg-red-50/10 cursor-pointer"
                            style={{ borderColor: 'rgba(220,50,50,0.2)' }}
                          >
                            Disconnect
                          </button>
                          <button
                            onClick={() => {
                              fetch('/api/google-auth/disconnect', { method: 'POST' }).then(() => {
                                fetch('/api/google-auth/setup', {
                                  method: 'POST',
                                  headers: { 'Content-Type': 'application/json' },
                                  body: JSON.stringify({ clientId: '', clientSecret: '', autoSync: false })
                                })
                                .then(() => {
                                  setGCalStatus({ configured: false, authenticated: false });
                                  setClientIdInput('');
                                  setClientSecretInput('');
                                });
                              });
                            }}
                            className="flex-1 py-1 px-2 text-[10px] rounded-md transition-all border text-muted-foreground hover:bg-muted-foreground/10 cursor-pointer"
                            style={{ borderColor: surfaceBdr }}
                          >
                            Reset Credentials
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>


            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>

      {/* â”€â”€ Task popover â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
          A parallel to the event popover rather than a fork of it: that one is
          370 lines of event-specific fields. The recurrence editor is shared. */}
      <AnimatePresence>
      {menuTask && taskMenuPos && (
        <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          data-menu="1"
          className="fixed z-[200] rounded-xl shadow-xl overflow-y-auto overflow-x-hidden"
          style={{
            left: Math.min(taskMenuPos.x, Math.max(8, window.innerWidth - 300)),
            top:  Math.min(taskMenuPos.y, Math.max(8, window.innerHeight - 420)),
            transformOrigin: 'top left',
            width: 284,
            maxHeight: 'calc(100vh - 16px)',
            background: menuBg,
            border: `1px solid ${menuBdr}`,
            boxShadow: darkMode
              ? '0 8px 32px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset'
              : '0 8px 32px rgba(0,0,0,0.14), 0 1px 0 rgba(255,255,255,0.9) inset',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
            <div className="flex items-center gap-1.5">
              <ListTodo size={13} style={{ color: taskColor }} />
              <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: menuSub }}>Task</span>
            </div>
            <button onClick={() => setTaskMenuId(null)} className="p-0.5 rounded" style={{ color: menuSub }}>
              <X size={13} />
            </button>
          </div>

          <div className="p-3 flex flex-col gap-2.5">
            <input
              value={menuTask.title}
              onChange={e => editTask(taskMenuId!, { title: e.target.value })}
              placeholder="Task title"
              autoFocus
              className="w-full bg-transparent outline-none text-[13px] font-medium rounded-md px-2 py-1.5"
              style={{ color: menuText, background: surfaceBg, border: `1px solid ${surfaceBdr}` }}
            />

            {/* Scheduling: no date (general) â†’ date only â†’ date + time. */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => editTask(taskMenuId!, withDueDate(menuTask, null, weekStartsOn))}
                className="px-2 py-1 rounded-md text-[11px] font-medium"
                style={{
                  background: menuTaskKind === 'general' ? `${taskColor}22` : surfaceBg,
                  border: `1px solid ${menuTaskKind === 'general' ? taskColor : surfaceBdr}`,
                  color: menuTaskKind === 'general' ? taskColor : menuSub,
                }}
              >
                No date
              </button>
              <input
                type="date"
                value={menuTaskDue ?? ''}
                onChange={e => e.target.value && editTask(taskMenuId!, withDueDate(menuTask, e.target.value, weekStartsOn))}
                className="flex-1 min-w-0 rounded-md px-2 py-1 text-[11px] outline-none"
                style={{ background: surfaceBg, color: menuText, border: `1px solid ${surfaceBdr}` }}
              />
            </div>

            <div className="flex items-center gap-1.5" style={{ opacity: menuTaskKind === 'general' ? 0.4 : 1, pointerEvents: menuTaskKind === 'general' ? 'none' : 'auto' }}>
              <Clock size={12} style={{ color: menuSub }} />
              <input
                type="time"
                value={menuTask.startTime ?? ''}
                onChange={e => editTask(taskMenuId!, withTime(menuTask, e.target.value || null))}
                className="flex-1 min-w-0 rounded-md px-2 py-1 text-[11px] outline-none"
                style={{ background: surfaceBg, color: menuText, border: `1px solid ${surfaceBdr}` }}
              />
              {menuTask.startTime && (
                <>
                  <span className="text-[11px]" style={{ color: menuSub }}>–</span>
                  <input
                    type="time"
                    value={menuTask.endTime ?? ''}
                    onChange={e => editTask(taskMenuId!, { endTime: e.target.value || undefined })}
                    className="flex-1 min-w-0 rounded-md px-2 py-1 text-[11px] outline-none"
                    style={{ background: surfaceBg, color: menuText, border: `1px solid ${surfaceBdr}` }}
                  />
                  <button
                    onClick={() => editTask(taskMenuId!, withTime(menuTask, null))}
                    className="p-1 rounded" style={{ color: menuSub }} title="Clear time"
                  >
                    <X size={11} />
                  </button>
                </>
              )}
            </div>

            <textarea
              value={menuTask.notes ?? ''}
              onChange={e => editTask(taskMenuId!, { notes: e.target.value })}
              placeholder="Notes…"
              rows={2}
              className="w-full rounded-md px-2 py-1.5 text-[11.5px] outline-none resize-y"
              style={{ background: surfaceBg, color: menuText, border: `1px solid ${surfaceBdr}` }}
            />

            {menuTaskKind !== 'general' && (
              <div style={{ borderTop: `1px solid ${menuBdr}`, paddingTop: 8 }}>
                <RecurrenceEditor
                  recur={menuTask.recur}
                  anchorWeekday={((menuTask.dayIndex ?? 0) + weekStartsOn) % 7 as Weekday}
                  onChange={r => editTask(taskMenuId!, { recur: r })}
                  theme={{ text: menuText, sub: menuSub, bdr: menuBdr, hover: hoverBg, accent: taskColor, accentBg: `${taskColor}22`, fieldBg: surfaceBg }}
                />
              </div>
            )}

            <div className="flex items-center gap-1.5 pt-1" style={{ borderTop: `1px solid ${menuBdr}` }}>
              <button
                onClick={() => { handleToggleTaskDone(taskMenuId!); }}
                className="flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11.5px] font-semibold"
                style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText }}
              >
                {menuTaskDone ? <Square size={12} /> : <CheckSquare size={12} />}
                {menuTaskDone ? 'Mark undone' : 'Mark done'}
              </button>
              <button
                onClick={() => deleteTask(taskMenuId!, menuTask.recur ? 'one' : 'all')}
                className="px-2 py-1.5 rounded-md text-[11.5px] font-semibold"
                style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: nowAccent }}
                title={menuTask.recur ? 'Delete this occurrence' : 'Delete task'}
              >
                <Trash2 size={12} />
              </button>
              {menuTask.recur && (
                <button
                  onClick={() => deleteTask(taskMenuId!, 'all')}
                  className="px-2 py-1.5 rounded-md text-[10.5px] font-semibold"
                  style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: nowAccent }}
                  title="Delete the whole series"
                >
                  All
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
      </AnimatePresence>

      {/* â”€â”€ Context menu (portal-style fixed popover) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */}
      <AnimatePresence>
      {menuEvent && menuPos && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.96 }}
          transition={{ duration: 0.15, ease: [0.22, 1, 0.36, 1] }}
          className="fixed z-[200] rounded-xl shadow-xl overflow-y-auto overflow-x-hidden"
          style={{
            left: menuPos.x,
            top:  menuPos.y,
            transformOrigin: 'top left',
            minWidth: 260,
            maxHeight: 'calc(100vh - 16px)',
            background: menuBg,
            border: `1px solid ${menuBdr}`,
            boxShadow: darkMode
              ? '0 8px 32px rgba(0,0,0,0.55), 0 1px 0 rgba(255,255,255,0.06) inset'
              : '0 8px 32px rgba(0,0,0,0.14), 0 1px 0 rgba(255,255,255,0.9) inset',
          }}
          onMouseDown={e => e.stopPropagation()}
        >
          {/* Drag handle — move the popup anywhere */}
          <div
            onMouseDown={startMenuDrag}
            className="flex items-center justify-center gap-1 py-1 select-none"
            style={{ cursor: 'grab', color: menuSub, borderBottom: `1px solid ${menuBdr}` }}
            title="Drag to move"
          >
            <GripHorizontal size={14} style={{ opacity: 0.6 }} />
          </div>

          {/* Title field (works for drafts, which have no grid block, and live items) */}
          <div className="px-3 pt-2 pb-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
            <input
              type="text"
              autoFocus={isDraft}
              value={menuEvent.content}
              placeholder="Add title"
              onChange={(e) => applyEdit(menuEvent.id, { content: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter' && isDraft) commitDraft(); }}
              className="w-full text-[13px] font-semibold rounded-md px-2 py-1.5 outline-none"
              style={{ background: hoverBg, border: `1px solid ${menuBdr}`, color: menuText }}
            />
          </div>

          {/* Day-of-week picker (draft only — the dedicated create has no clicked day) */}
          {isDraft && (
            <div className="px-3 py-2 flex items-center gap-1" style={{ borderBottom: `1px solid ${menuBdr}` }}>
              {days.map((d, i) => {
                const sel = menuEvent.dayIndex === i;
                return (
                  <button key={i} type="button"
                    onClick={() => applyEdit(menuEvent.id, { dayIndex: i })}
                    className="flex-1 text-[10px] font-semibold rounded-md py-1 transition-colors"
                    style={{
                      color: sel ? '#fff' : menuText,
                      background: sel ? '#5b9d5b' : hoverBg,
                      border: `1px solid ${menuBdr}`,
                    }}
                  >
                    {format(d, 'EEEEE')}
                  </button>
                );
              })}
            </div>
          )}

          {/* Precise start/end time editors */}
          {!menuEvent.allDay && (
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
                      applyEdit(menuEvent.id, { [field]: val });
                    }}
                    className="w-full text-[11px] font-medium tabular-nums rounded-md px-1.5 py-1 outline-none"
                    style={{ background: hoverBg, border: `1px solid ${menuBdr}`, color: menuText }}
                  />
                </div>
              ))}
            </div>
          )}

          {/* All-day event toggle */}
          <button
            className="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-left text-[12px] font-medium transition-colors"
            style={{ color: menuText, borderBottom: `1px solid ${menuBdr}` }}
            onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => {
              const nextAllDay = !menuEvent.allDay;
              const patches: Partial<PlannerEvent> = { allDay: nextAllDay };
              if (!nextAllDay) {
                patches.daysSpan = undefined;
              }
              applyEdit(menuEvent.id, patches);
            }}
          >
            <span className="flex items-center gap-2.5">
              <Clock size={13} style={{ opacity: 0.7 }} />
              All-day event
            </span>
            <span
              className="flex items-center rounded-full transition-colors"
              style={{
                width: 30, height: 17, padding: 2,
                background: menuEvent.allDay ? '#5b9d5b' : (darkMode ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'),
                justifyContent: menuEvent.allDay ? 'flex-end' : 'flex-start',
              }}
            >
              <span style={{ width: 13, height: 13, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }} />
            </span>
          </button>

          {/* All-day span selector */}
          {menuEvent.allDay && (
            <div className="px-3 py-2 flex items-center justify-between" style={{ borderBottom: `1px solid ${menuBdr}` }}>
              <span className="text-[11px] font-medium" style={{ color: menuText }}>Duration (days)</span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    const currentSpan = menuEvent.daysSpan || 1;
                    if (currentSpan > 1) {
                      applyEdit(menuEvent.id, { daysSpan: currentSpan - 1 });
                    }
                  }}
                  disabled={(menuEvent.daysSpan || 1) <= 1}
                  className="w-5 h-5 rounded border flex items-center justify-center text-xs bg-muted/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ color: menuText, borderColor: menuBdr }}
                  onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.03)')}
                >
                  -
                </button>
                <span className="text-xs font-semibold w-5 text-center tabular-nums" style={{ color: menuText }}>
                  {menuEvent.daysSpan || 1}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    const currentSpan = menuEvent.daysSpan || 1;
                    if (currentSpan < 90) {
                      applyEdit(menuEvent.id, { daysSpan: currentSpan + 1 });
                    }
                  }}
                  disabled={(menuEvent.daysSpan || 1) >= 90}
                  className="w-5 h-5 rounded border flex items-center justify-center text-xs bg-muted/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
                  style={{ color: menuText, borderColor: menuBdr }}
                  onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                  onMouseLeave={e => (e.currentTarget.style.background = 'rgba(0,0,0,0.03)')}
                >
                  +
                </button>
              </div>
            </div>
          )}

          {/* Completion-checkbox toggle */}
          <button
            className="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-left text-[12px] font-medium transition-colors"
            style={{ color: menuText, borderBottom: `1px solid ${menuBdr}` }}
            onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            onClick={() => applyEdit(menuEvent.id, { noCheckbox: !menuEvent.noCheckbox })}
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

          {/* Expanded Color Section */}
          <div className="px-3 py-2.5 flex flex-col gap-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
            <div className="flex items-center justify-between">
              <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: menuSub }}>Color Options</span>
              {menuEvent.gCalHex && (
                <span className="text-[9px] font-medium px-1.5 py-0.5 rounded flex items-center gap-1" style={{ background: darkMode ? 'rgba(59,130,246,0.18)' : 'rgba(37,99,235,0.1)', color: darkMode ? '#93c5fd' : '#2563eb' }}>
                  <Sparkles size={9} /> Google Calendar
                </span>
              )}
            </div>

            {/* 10 Preset Swatches Grid */}
            <div className="grid grid-cols-5 gap-1.5 pt-0.5">
              {SWATCHES.map(c => {
                const sc = chipColors({ color: c } as PlannerEvent);
                const isCustomHex = menuEvent.color?.startsWith('#');
                const gcalPresetMatch = menuEvent.gCalHex ? matchPresetColor(menuEvent.gCalHex) : null;
                const isSelected = isCustomHex
                  ? false
                  : (menuEvent.gCalHex
                    ? (gcalPresetMatch === c)
                    : (menuEvent.color === c));
                return (
                  <button key={c} type="button"
                    title={c.charAt(0).toUpperCase() + c.slice(1)}
                    onClick={() => applyEdit(menuEvent.id, { color: c })}
                    className="h-4.5 rounded-full border transition-transform hover:scale-115 flex items-center justify-center cursor-pointer"
                    style={{
                      backgroundColor: sc.bg,
                      borderColor: sc.border,
                      outline: isSelected ? `2px solid ${sc.text}` : 'none',
                      outlineOffset: 1,
                    }}
                  />
                );
              })}
            </div>

            {/* Custom / RGB Color Panel */}
            <div className="flex items-center gap-2 pt-2 mt-1 border-t border-dashed" style={{ borderColor: menuBdr }}>
              <span className="text-[10px] font-medium" style={{ color: menuSub }}>Custom RGB:</span>
              <div className="flex items-center gap-1.5 flex-1">
                <input
                  type="color"
                  value={menuEvent.color?.startsWith('#') ? menuEvent.color : (menuEvent.gCalHex || '#3b82f6')}
                  onChange={(e) => applyEdit(menuEvent.id, { color: e.target.value })}
                  className="w-5 h-5 rounded cursor-pointer border-0 bg-transparent p-0"
                  title="Choose custom RGB color"
                />
                <input
                  type="text"
                  value={menuEvent.color?.startsWith('#') ? menuEvent.color : (menuEvent.gCalHex && !matchPresetColor(menuEvent.gCalHex) ? menuEvent.gCalHex : '')}
                  placeholder="#Hex (e.g. #3b82f6)"
                  onChange={(e) => {
                    const val = e.target.value.trim();
                    if (/^#[0-9a-fA-F]{6}$/.test(val) || val === '') {
                      applyEdit(menuEvent.id, { color: val || 'sage' });
                    }
                  }}
                  className="px-2 py-0.5 rounded text-[10px] font-mono flex-1 bg-transparent border outline-none"
                  style={{ color: menuText, borderColor: menuBdr }}
                />
              </div>
            </div>
          </div>

          {/* Repeat */}
          <RecurrenceEditor
            recur={menuEvent.recur}
            anchorWeekday={new Date((menuEvent.occDate || viewedWeekKey) + 'T00:00:00').getDay() as Weekday}
            onChange={(r) => applyEdit(menuEvent.id, { recur: r })}
            theme={{ text: menuText, sub: menuSub, bdr: menuBdr, hover: hoverBg, accent: darkMode ? '#93c5fd' : '#2563eb', accentBg: darkMode ? 'rgba(96,165,250,0.18)' : 'rgba(37,99,235,0.10)', fieldBg: darkMode ? 'rgba(255,255,255,0.06)' : '#fff' }}
          />

          {/* Lock-to-series toggle (repeating items only). OFF (default): editing or
              moving this occurrence detaches it into a free standalone item. ON: every
              occurrence stays identical — changes apply to the whole series. */}
          {!!menuEvent.recur && (
            <button
              className="w-full flex items-center justify-between gap-2.5 px-3 py-2 text-left text-[12px] font-medium transition-colors"
              style={{ color: menuText, borderBottom: `1px solid ${menuBdr}` }}
              onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={() => applyEdit(menuEvent.id, { locked: !menuEvent.locked })}
              title={menuEvent.locked
                ? 'Changes apply to every occurrence in this series'
                : 'Editing or moving this one detaches it from the series'}
            >
              <span className="flex items-center gap-2.5">
                {menuEvent.locked ? <Link2 size={13} style={{ opacity: 0.7 }} /> : <Link2Off size={13} style={{ opacity: 0.7 }} />}
                Lock to series
              </span>
              <span
                className="flex items-center rounded-full transition-colors"
                style={{
                  width: 30, height: 17, padding: 2,
                  background: menuEvent.locked ? '#5b9d5b' : (darkMode ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'),
                  justifyContent: menuEvent.locked ? 'flex-end' : 'flex-start',
                }}
              >
                <span style={{ width: 13, height: 13, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.3)' }} />
              </span>
            </button>
          )}

          {/* Linked items — couple this item to the one above or below it, like
              train carriages. Coupled items move as one: dragging any of them, or
              dragging this one's START edge, carries the rest along. */}
          {!isDraft && !menuEvent.allDay && (() => {
            const linkedNow = linkedIdsOf(menuEvent, menuEvent.id).filter(lid => lid !== menuEvent.id);
            const above = linkNeighbour(menuEvent.id, 'prev');
            const below = linkNeighbour(menuEvent.id, 'next');
            return (
              <div className="px-3 py-2.5 flex flex-col gap-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
                <div className="flex items-center justify-between">
                  <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: menuSub }}>Linked movement</span>
                  {linkedNow.length > 0 && (
                    <span className="text-[9px] font-semibold px-1.5 py-0.5 rounded" style={{ background: 'rgba(96,165,250,0.18)', color: '#93c5fd' }}>
                      {linkedNow.length + 1} coupled
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={!above}
                    onClick={() => linkToNeighbour(menuEvent.id, 'prev')}
                    className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[11px] font-semibold transition-colors"
                    style={{
                      background: hoverBg, border: `1px solid ${menuBdr}`, color: menuText,
                      opacity: above ? 1 : 0.4, cursor: above ? 'pointer' : 'default',
                    }}
                    title={above ? `Couple to “${above.ev.content || 'Untitled'}” above` : 'Nothing above this item today'}
                  >
                    <ChevronUp size={12} /> Link above
                  </button>
                  <button
                    type="button"
                    disabled={!below}
                    onClick={() => linkToNeighbour(menuEvent.id, 'next')}
                    className="flex-1 flex items-center justify-center gap-1 py-1.5 rounded-md text-[11px] font-semibold transition-colors"
                    style={{
                      background: hoverBg, border: `1px solid ${menuBdr}`, color: menuText,
                      opacity: below ? 1 : 0.4, cursor: below ? 'pointer' : 'default',
                    }}
                    title={below ? `Couple to “${below.ev.content || 'Untitled'}” below` : 'Nothing below this item today'}
                  >
                    <ChevronDown size={12} /> Link below
                  </button>
                </div>
                {linkedNow.length > 0 && (
                  <>
                    <div className="flex flex-col gap-0.5">
                      {linkedNow.map(lid => {
                        const partner = weekEvents[lid] ?? events[lid];
                        if (!partner) return null;
                        return (
                          <span key={lid} className="text-[10px] truncate flex items-center gap-1" style={{ color: menuSub }}>
                            <Link2 size={9} style={{ opacity: 0.7, flexShrink: 0 }} />
                            {partner.content || 'Untitled'} · {formatTimeLabel(timeToMin(partner.startTime), timeFormat)}
                          </span>
                        );
                      })}
                    </div>
                    <button
                      type="button"
                      onClick={() => unlinkItem(menuEvent.id)}
                      className="w-full flex items-center justify-center gap-1 py-1.5 rounded-md text-[11px] font-semibold transition-colors"
                      style={{ background: 'transparent', border: `1px solid ${menuBdr}`, color: '#f87171' }}
                      title="Uncouple this item; the rest stay linked to each other"
                    >
                      <Link2Off size={12} /> Unlink this item
                    </button>
                  </>
                )}
              </div>
            );
          })()}

          {/* Draft footer: commit or discard (dedicated create) */}
          {isDraft && (
            <div className="flex gap-2 px-3 py-2.5">
              <button
                onClick={() => { setMenuId(null); setMenuPos(null); }}
                className="flex-1 py-1.5 text-[12px] font-semibold rounded-md transition-colors"
                style={{ color: menuText, background: hoverBg, border: `1px solid ${menuBdr}` }}
              >
                Cancel
              </button>
              <button
                onClick={commitDraft}
                className="flex-1 py-1.5 text-[12px] font-semibold rounded-md text-white transition-colors"
                style={{ background: '#5b9d5b' }}
              >
                Save
              </button>
            </div>
          )}

          {/* Actions (live items only — a draft isn't on the grid yet) */}
          {!isDraft && [
            { icon: <Pencil size={13}/>, label: 'Edit', action: () => { enterEdit(menuEvent.id); } },
            { icon: <CalendarRange size={13}/>, label: 'Clone to whole week', action: () => cloneAcrossWeek(menuEvent) },
          ].map(({ icon, label, action }) => (
            <button
              key={label}
              className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[12px] font-medium transition-colors"
              style={{ color: menuText }}
              onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              onClick={action}
            >
              <span style={{ opacity: 0.7 }}>{icon}</span>
              {label}
            </button>
          ))}

          {/* Delete — scoped for repeating items */}
          {!isDraft && (() => {
            const repeating = !!menuEvent.recur;
            const del = (mode: DeleteMode) => { applyDelete(menuEvent.id, mode); if (editingId === menuEvent.id) setEditingId(null); setMenuId(null); setMenuPos(null); };
            const row = (label: string, onClick: () => void, indent = false) => (
              <button key={label}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-[12px] font-medium transition-colors"
                style={{ color: '#e05555', paddingLeft: indent ? 34 : undefined }}
                onMouseEnter={e => (e.currentTarget.style.background = 'rgba(224,85,85,0.10)')}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                onClick={onClick}
              >
                {!indent && <span style={{ opacity: 0.7 }}><Trash2 size={13}/></span>}
                {label}
              </button>
            );
            if (!repeating) return row('Delete', () => del('all'));
            return (
              <>
                {row('Delete', () => del('one'))}
                {!deleteExpanded
                  ? row('Delete more…', () => setDeleteExpanded(true))
                  : (<>
                      {row('This and following events', () => del('following'), true)}
                      {row('All events', () => del('all'), true)}
                    </>)}
              </>
            );
          })()}
        </motion.div>
      )}
      </AnimatePresence>



    </div>
  );
}
