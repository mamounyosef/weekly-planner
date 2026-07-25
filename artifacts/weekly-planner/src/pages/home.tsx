import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { flushSync } from 'react-dom';
import {
  format,
  addWeeks,
  subWeeks,
  addMonths,
  subMonths,
  startOfWeek,
  endOfWeek,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isToday,
  isSameMonth,
  isSameDay,
  addDays,
  subDays,
  differenceInDays,
} from 'date-fns';
import { ChevronLeft, ChevronRight, X, Moon, Sun, Pencil, CalendarRange, Trash2, Settings, AppWindow, CheckSquare, Undo2, Redo2, Target, BarChart3, Play, Pause, RotateCcw, Plus, Minus, Flame, Award, TrendingUp, Home, Clock, GripHorizontal, Link2, Link2Off, Keyboard, Volume2 } from 'lucide-react';
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
  loadLocalFocusSessions,
  loadLocalFocusTimer,
  coerceFocusTimer,
  focusTimerPushKey,
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
} from '@/lib/focusSessions';
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
} from '@/lib/recurrence';

// ─── TEMP DEBUG: surface the real error the overlay hides ───────────────────────
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

// ─── Types ────────────────────────────────────────────────────────────────────
type IntervalMin   = 5 | 15 | 30 | 60;
type EventColor    = 'sage' | 'peach' | 'blue' | 'sand' | 'lilac';
type TimeFormat    = '12h' | '24h';
type WeekStartsOn  = 0 | 1 | 2 | 3 | 4 | 5 | 6; // 0=Sun … 6=Sat

// Calendar zoom levels, narrowest → widest. Ctrl+wheel steps along this axis.
type CalendarView = 'day' | 'week' | 'month' | 'year';
const CALENDAR_VIEWS: CalendarView[] = ['day', 'week', 'month', 'year'];
const isCalendarView = (v: unknown): v is CalendarView =>
  typeof v === 'string' && (CALENDAR_VIEWS as string[]).includes(v);

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
  gCalRecurSig?: string;
  lastSyncedAt?: number;
  updatedAt?: number;
  // ── Recurrence (Google-style, see src/lib/recurrence.ts) ──
  weekKey?: string;            // week-start date of the anchor (first) occurrence
  recur?: Recurrence;          // absent = does not repeat
  exdates?: string[];          // 'yyyy-MM-dd' occurrence dates removed individually
  locked?: boolean;            // repeating master: edits/moves apply to whole series (default off)
  deleted?: boolean;           // tombstone awaiting a Google-side delete, then removal
  // View-only, stamped onto expanded occurrences (never persisted):
  masterId?: string;
  occDate?: string;
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

// ─── All-Day Layout Stacking ───────────────────────────────────────────────
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

// Helper to calculate the visible dayIndex and daysSpan of an all-day event
// within the viewed week (which starts at weekStart). Returns null if it doesn't overlap.
function getEventWeekOverlap(ev: PlannerEvent, weekStart: Date): { dayIndex: number; daysSpan: number } | null {
  const evWeekStart = new Date(ev.weekKey || '0000-01-01');
  const evStart = addDays(evWeekStart, ev.dayIndex);
  const evEnd = addDays(evStart, ev.daysSpan || 1);
  const weekEnd = addDays(weekStart, 7);

  if (evStart >= weekEnd || evEnd <= weekStart) {
    return null;
  }

  const startDiff = differenceInDays(evStart, weekStart);
  const visibleDayIndex = Math.max(0, startDiff);
  
  const endDiff = differenceInDays(evEnd, weekStart);
  const visibleDaysSpan = Math.min(7, endDiff) - visibleDayIndex;

  return {
    dayIndex: visibleDayIndex,
    daysSpan: visibleDaysSpan
  };
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

// ─── Recurrence editor ───────────────────────────────────────────────────────
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

// ─── Main Component ────────────────────────────────────────────────────────────
export default function WeeklyPlanner() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [interval, setIntervalOpt]    = useState<IntervalMin>(5);
  const [events, setEvents]           = useState<PlannerData>({});
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
  const [autoBackup, setAutoBackup] = useState<AutoBackupCfg>(AUTO_BACKUP_DEFAULT);
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
  // A brand-new item started from the dedicated "＋" button lives here as an
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
  const [direction, setDirection]     = useState(0);
  const [darkMode, setDarkMode]       = useState(true);
  const [timeFormat, setTimeFormat]     = useState<TimeFormat>('12h');
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(0);
  // Zoom levels, narrowest → widest. Ctrl+wheel steps through them.
  const [calendarView, setCalendarView] = useState<CalendarView>('week');
  // App zoom (NOT browser zoom): Ctrl +/- and the header stepper drive this, and
  // it's applied as CSS `zoom` on the root so layout reflows instead of blurring.
  const [appZoom, setAppZoom] = useState(1);
  const [zoomDraft, setZoomDraft] = useState('100');
  const [editingZoom, setEditingZoom] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
  const [selRect, setSelRect]           = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [batchDisp, setBatchDisp]       = useState<{ [id: string]: { dayIndex: number; startMin: number } } | null>(null);
  const [nowTick, setNowTick]           = useState(Date.now());
  const [dayStartH, setDayStartH]       = useState(7);
  const [dayEndH, setDayEndH]           = useState(31);
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
  // Google Calendar Integration State
  const [gCalStatus, setGCalStatus] = useState<{
    configured: boolean;
    authenticated: boolean;
    email?: string;
    autoSync?: boolean;
    clientId?: string;
    clientSecret?: string;
  }>({ configured: false, authenticated: false });
  const [gCalSyncing, setGCalSyncing] = useState(false);
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
      editCtxRef.current.viewedWeekKey,
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
    eventId: string; durationMin: number; offsetMin: number;
    origDay: number; curDay: number; curStartMin: number;
    active: boolean; initX: number; initY: number;
  } | null>(null);

  const resizeRef = useRef<{
    eventId: string; edge: 'top' | 'bottom'; startMin: number; endMin: number;
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
      body: JSON.stringify({ events: launched, weekStartsOn })
    })
    .then(r => r.json())
    .then(res => {
      if (res.success && res.events) {
        const serverMap: PlannerData = res.events;
        const live = eventsRef.current;
        // Merge, don't replace: for records the user touched mid-flight (live differs
        // from the snapshot we sent), keep the live content and only adopt the Google
        // identity fields the server resolved. Untouched records take the server value.
        const merged: PlannerData = { ...serverMap };
        // Records we deleted while this (older) sync was in flight are gone from live
        // but still present in the stale serverMap. Without this, the server's copy
        // would resurrect them ~seconds later. Anything we *sent* (was in launched)
        // that no longer exists locally was deleted mid-flight → drop it. Records the
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
          if (status.clientSecret) setClientSecretInput(status.clientSecret);
        });
    });
  }, [weekStartsOn, showToast]);
  // Stable ref so the queue-drain above can call the latest triggerGCalSync.
  const triggerGCalSyncRef = useRef(triggerGCalSync);
  useEffect(() => { triggerGCalSyncRef.current = triggerGCalSync; }, [triggerGCalSync]);

  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    if (code) {
      window.history.replaceState({}, document.title, window.location.pathname);
      const redirectUri = window.location.origin;
      fetch('/api/google-auth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, redirectUri })
      })
      .then(r => r.json())
      .then(res => {
        if (res.success) {
          triggerGCalSync();
        } else {
          console.error('Failed to exchange auth code:', res.error);
        }
      })
      .catch(err => console.error('Error during token exchange:', err));
    }
  }, [triggerGCalSync]);

  useEffect(() => {
    if (!gCalStatus.authenticated || !gCalStatus.autoSync) return;
    const intervalId = setInterval(() => {
      triggerGCalSync();
    }, 4 * 60 * 1000);
    return () => clearInterval(intervalId);
  }, [gCalStatus.authenticated, gCalStatus.autoSync, triggerGCalSync]);

  useEffect(() => {
    if (isInitialMount.current || !gCalStatus.authenticated) return;
    // Never push mid-edit: while an item is focused for editing (e.g. typing a
    // title) we hold off. The push fires once editing finishes (editingId → null,
    // i.e. focus leaves the item) or after a structural change settles.
    if (editingId !== null) return;
    // If this render is the result of applying a sync response, don't sync again.
    if (gcalEchoRef.current === events) { gcalEchoRef.current = null; return; }
    const timer = setTimeout(() => { triggerGCalSync(); }, 800);
    return () => clearTimeout(timer);
  }, [events, editingId, gCalStatus.authenticated, triggerGCalSync]);


  // ── Derived ───────────────────────────────────────────────────────────────
  const weekStart   = startOfWeek(currentDate, { weekStartsOn });
  const days        = eachDayOfInterval({ start: weekStart, end: endOfWeek(currentDate, { weekStartsOn }) });
  // Day view reuses the whole week grid but paints a single column. Events keep
  // their 0–6 week-relative dayIndex, so everything below works off this mapping
  // between a *visible slot* and the real day index it stands for.
  const dayViewColIdx = (currentDate.getDay() - weekStartsOn + 7) % 7;
  const visibleCols   = calendarView === 'day' ? [dayViewColIdx] : [0, 1, 2, 3, 4, 5, 6];
  const colCount      = visibleCols.length;
  /** Visible slot for a week dayIndex, or -1 when that day isn't on screen. */
  const colSlot = (dayIndex: number) => visibleCols.indexOf(dayIndex);
  // Grids that render the timeline use these so day view stretches to full width.
  const isDayView = calendarView === 'day';
  // Both 'day' and 'week' render the timeline grid.
  const isTimelineView = calendarView === 'day' || calendarView === 'week';
  // Long-lived mouse handlers read the visible columns through a ref.
  const visibleColsRef = useRef<number[]>(visibleCols);
  visibleColsRef.current = visibleCols;
  const slots       = generateSlots(interval, dayStartH, dayEndH);
  const sh          = SLOT_H[interval];
  const totalH      = slots.length * sh;
  const dayEndMin   = dayEndH * 60;
  const dayStartMin = dayStartH * 60;
  const colorPalette = darkMode ? DARK_EVENT_COLORS : EVENT_COLORS;

  // ── Modification domain / week resolution ──────────────────────────────────
  const viewedWeekKey     = weekKeyOf(currentDate, weekStartsOn);
  const currentRealWeekKey = weekKeyOf(new Date(nowTick), weekStartsOn);
  const isPastWeek        = viewedWeekKey < currentRealWeekKey;
  // Items visible in the viewed week, keyed by the storage id actually shown.
  const weekEvents = useMemo(() => resolveWeek(events, viewedWeekKey), [events, viewedWeekKey]);
  const weekAllDayEvents = useMemo(() => {
    const rawAllDays = Object.values(weekEvents).filter(ev => ev.allDay && !ev.deleted);
    const mapped: Array<PlannerEvent & { visibleDayIndex: number; visibleDaysSpan: number }> = [];
    for (const ev of rawAllDays) {
      const overlap = getEventWeekOverlap(ev, weekStart);
      if (overlap) {
        mapped.push({
          ...ev,
          visibleDayIndex: overlap.dayIndex,
          visibleDaysSpan: overlap.daysSpan
        });
      }
    }
    return mapped;
  }, [weekEvents, weekStart]);
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
      const cells = chunk.map((date, col) => ({
        date,
        events: Object.values(resolved)
          .filter(e => e.dayIndex === col)
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
        const count = Object.values(resolveCached(wkey)).filter(e => e.dayIndex === col).length;
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
    eventsRef.current = next;
    setEvents(next);
  }, []);

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
    const stamped = stampNewItem(base, editCtxRef.current.viewedWeekKey);
    writeEvents({ ...eventsRef.current, [stamped.id]: stamped });
    if (opts?.edit) setEditingId(stamped.id);
    if (opts?.menuAt) { setMenuPinned(false); setMenuId(stamped.id); setMenuPos(opts.menuAt); }
    return stamped.id;
  }, [writeEvents]);
  const createStampedRef = useRef(createStamped);
  useEffect(() => { createStampedRef.current = createStamped; }, [createStamped]);

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

  // ── Live time indicator ────────────────────────────────────────────────────
  const nowDate = useMemo(() => new Date(nowTick), [nowTick]);
  const nowMin  = nowDate.getHours() * 60 + nowDate.getMinutes();
  const normNowMin = normalizeMin(nowMin, dayStartH);
  const nowInView = normNowMin >= dayStartMin && normNowMin <= dayEndMin;
  // A day column spans dayStartH → dayStartH+24 (e.g. 7am → 7am). So between
  // midnight and the day-start hour, "now" belongs to the PREVIOUS calendar day's
  // column, not today's — otherwise the red line lands a whole day too far right.
  const nowOwnerDate = nowMin < dayStartMin ? subDays(nowDate, 1) : nowDate;
  const nowColIdx = days.findIndex(d => isSameDay(d, nowOwnerDate));
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

  // Away from "now" entirely → the pill is the way back, so it should always be
  // offered (there's no now-line on screen to scroll to at all). Day view is away
  // whenever the shown day isn't today; week view whenever the week differs.
  const viewingAnotherWeek = calendarView === 'day'
    ? !isToday(currentDate)
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
    // No line on screen (other week / month view / analysis) → jump to now first.
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

  // ── Focus analysis (month / year) ──────────────────────────────────────────
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
    } catch (_) { /* fall back to the poll */ }

    // Safety net only — the stream is what makes this feel instant.
    const focusPollId = setInterval(loadFocusSessions, 15000);
    return () => { clearInterval(focusPollId); if (dbStream) dbStream.close(); };
  }, [writeEvents]);

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
  // When this window last saved events, and whether the user is mid-interaction —
  // both gate whether a pushed database change may be adopted here.
  const lastLocalEventsWriteRef = useRef(0);
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
      const json = JSON.stringify(coerceFocusTimer(data));
      timerHydratedRef.current = true;
      if (json === lastTimerJsonRef.current) return; // our own echo / no change
      // Don't let a stale server read clobber a change we just made locally
      // (the server may not have stored our push yet).
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
      setFocusTimer(prev => (prev.isRunning && prev.lastStartedAt
        ? { ...prev, accumulatedSeconds: getFocusTimerElapsedSeconds(prev), lastStartedAt: new Date().toISOString() }
        : prev));
    }, 5000);
    return () => {
      window.removeEventListener('storage', handleStorage);
      clearInterval(pollId);
      clearInterval(checkpointId);
      if (stream) stream.close();
    };
  }, []);

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
      // Auto-completions get a deterministic id so the main window and the widget
      // (which both hit zero independently) collapse into a single logged session.
      id: auto ? autoSessionId(focusTimer.sessionStartedAt, focusTimer.plannedSeconds) : focusUid(),
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
    // Don't push to the backend until we've hydrated from it — otherwise our initial
    // (empty/stale) state could overwrite a live session owned by another window.
    if (!timerHydratedRef.current) return;
    // Push to the shared backend (skip if this value just arrived from a pull).
    const json = JSON.stringify(coerceFocusTimer(focusTimer));
    if (json === lastTimerJsonRef.current) return;
    // A running-session checkpoint isn't a real change — pushing it would stomp a
    // start/pause made from the widget or the system-wide hotkey.
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
      // The chime is claimed through the server for the same reason the cues are:
      // the two windows are different browser engines and can't see each other's
      // localStorage, so a local claim would always succeed in both.
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
      // Hitting zero is a completion, not a pause — the chime covers that.
      if (focusRemainingSeconds > 0) slot = 'pause';
    }
    if (!slot) return;
    const cue = focusCuesRef.current[slot];
    if (cue === 'none') return;
    claimFocusCue(focusCueKey(slot, focusTimer), () => playFocusCue(cue));
  }, [focusTimer, focusRemainingSeconds]);

  const startFocus = () => {
    const startedAt = new Date().toISOString();
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

  // ── Persistence & Backend Sync ───────────────────────────────────────────
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
    setShortcuts(loadShortcuts());
    const savedZoom = parseFloat(localStorage.getItem(ZOOM_KEY) || '');
    if (Number.isFinite(savedZoom)) setAppZoom(clampZoom(savedZoom));

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
          if (isCalendarView(s.calendarView)) setCalendarView(s.calendarView);
          if (s.focusDayStartHour != null) setFocusDayStartHour(Math.max(0, Math.min(23, Number(s.focusDayStartHour))));
          if (s.focusChime != null) setFocusChime(coerceFocusChime(s.focusChime));
          if (s.focusCues && typeof s.focusCues === 'object') {
            const c = s.focusCues as Record<string, unknown>;
            setFocusCues({
              start: coerceFocusCue(c.start, 'start'),
              pause: coerceFocusCue(c.pause, 'pause'),
              resume: coerceFocusCue(c.resume, 'resume'),
            });
          }
          if (s.shortcuts) setShortcuts(coerceShortcuts(s.shortcuts));
          if (s.autoBackup && typeof s.autoBackup === 'object') {
            setAutoBackup(coerceAutoBackup(s.autoBackup));
          }
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

  // Persist settings to the shared backend whenever any of them change (after initial load).
  useEffect(() => {
    if (!settingsLoaded.current) return;
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ interval, darkMode, timeFormat, weekStartsOn, dayStartH, dayEndH, calendarView, focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup }),
    }).catch(err => console.error('Failed to save settings to backend:', err));
  }, [interval, darkMode, timeFormat, weekStartsOn, dayStartH, dayEndH, calendarView, focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup]);

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

  // ── Backup & Restore ──────────────────────────────────────────────────────
  // Covers all three database files (events, settings, focus-sessions) so a
  // single exported file is a complete snapshot of the whole app's data.
  const BACKUP_FORMAT_VERSION = 2;

  const exportBackup = () => {
    const backup = {
      backupFormatVersion: BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      events,
      settings: { interval, darkMode, timeFormat, weekStartsOn, dayStartH, dayEndH, calendarView, focusDayStartHour },
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
        fetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(migrated),
        }).catch(() => showToast('Imported locally, but saving to the server failed.', 'error'));

        if (s && typeof s === 'object') {
          if (s.interval != null) setIntervalOpt(s.interval as IntervalMin);
          if (typeof s.darkMode === 'boolean') setDarkMode(s.darkMode);
          if (s.timeFormat) setTimeFormat(s.timeFormat as TimeFormat);
          if (s.weekStartsOn != null) setWeekStartsOn(s.weekStartsOn as WeekStartsOn);
          if (s.dayStartH != null) setDayStartH(s.dayStartH);
          if (s.dayEndH != null) setDayEndH(s.dayEndH);
          if (isCalendarView(s.calendarView)) setCalendarView(s.calendarView);
          if (s.focusDayStartHour != null) setFocusDayStartHour(Math.max(0, Math.min(23, Number(s.focusDayStartHour))));
        }

        if (sessions) {
          const safeSessions = safeFocusSessions(sessions);
          setFocusSessions(safeSessions);
          persistFocusSessions(safeSessions);
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
    // Map the cursor to a VISIBLE slot, then back to the real week dayIndex —
    // in day view there is only one slot but it may stand for any day 0–6.
    const cols     = visibleColsRef.current;
    const colW     = rect.width / cols.length;
    const slot     = clamp(Math.floor((clientX - rect.left) / colW), 0, cols.length - 1);
    const dayIndex = cols[slot];
    const snapped  = clamp(yToMin(Math.max(0, clientY - rect.top - HEADER_PX - allDayHeight), interval, dayStartH), dayStartMin, dayEndMin - POSITION_SNAP);
    return { dayIndex, slot, snappedMin: snapped };
  }, [interval, dayStartMin, dayEndMin, allDayHeight]);

  // ── Keyboard Shortcuts (Escape, Delete/Backspace, Copy/Paste) ─────────────
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

      // ── Rebindable navigation / view actions ──────────────────────────────
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
        if (!(mp.x >= rect.left && mp.x <= rect.right && mp.y >= rect.top + HEADER_PX + allDayHeight && mp.y <= rect.bottom)) {
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
          const targetDay = clamp(coords.dayIndex + dayOffset, 0, 6);
          const targetStart = clamp(coords.snappedMin + timeOffset, dayStartRef.current * 60, dayEndRef.current * 60 - duration);
          // A pasted copy is a fresh, standalone item: strip recurrence + Google
          // identity so it never mutates the source's series or sync record.
          stampedNew[newId] = stampNewItem({
            ...ev, id: newId, dayIndex: targetDay,
            startTime: minToTime(targetStart), endTime: minToTime(targetStart + duration),
            recur: undefined, exdates: undefined, masterId: undefined, occDate: undefined,
            gCalId: undefined, gCalCalendarId: undefined, gCalETag: undefined, gCalRecurSig: undefined, lastSyncedAt: undefined, deleted: undefined,
          } as PlannerEvent, wk);
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
          // Not over the grid → drop copies near the originals (+10 min).
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
            } as PlannerEvent, wk);
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
  }, [getGridCoords, allDayHeight]);

  // ── Global mouse move / up ────────────────────────────────────────────────
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
        const deltaMin = clamp(snapMin(coords.snappedMin - br.baseMouseMin, POSITION_SNAP), -dayStartMin * 4, dayEndMin);
        const newBatchDisp: { [id: string]: { dayIndex: number; startMin: number } } = {};
        for (const id of br.eventIds) {
          const newStart = clamp(br.baseStartMins[id] + deltaMin, dayStartMin, dayEndMin - br.durations[id]);
          const newDay = clamp(br.baseDays[id] + dayDelta, 0, 6);
          newBatchDisp[id] = { dayIndex: newDay, startMin: newStart };
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
        const curY = e.clientY - rect.top - HEADER_PX - allDayHeight;
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
        const curY = e.clientY - rect.top - HEADER_PX - allDayHeight;
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
        const newStart = clamp(snapMin(coords.snappedMin - dr.offsetMin, POSITION_SNAP), dayStartMin, dayEndMin - dr.durationMin);
        dr.curDay = coords.dayIndex; dr.curStartMin = newStart;
        setDragDisp({ id: dr.eventId, day: coords.dayIndex, startMin: newStart });
        setDragDelta({ x: e.clientX - dr.initX, y: e.clientY - dr.initY });
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
            const curY = e.clientY - rect.top - HEADER_PX - allDayHeight;
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
          const colW = gridRect.width / 7;
          const curX = e.clientX - gridRect.left;
          const curY = e.clientY - gridRect.top - HEADER_PX - allDayHeight;
          const left = Math.min(sr.startX, curX);
          const right = Math.max(sr.startX, curX);
          const topPx = Math.min(sr.startY, curY);
          const bottomPx = Math.max(sr.startY, curY);
          const topMin = yToMin(Math.max(0, topPx), interval, dayStartH);
          const bottomMin = yToMin(Math.max(0, bottomPx), interval, dayStartH);
          const idsToAdd: string[] = [];
          for (const [id, ev] of Object.entries(weekEventsRef.current)) {
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
          const ev = weekEventsRef.current[dr.eventId] ?? eventsRef.current[dr.eventId];
          if (ev) {
            applyEditRef.current(dr.eventId, { dayIndex: dr.curDay, startTime: minToTime(dr.curStartMin), endTime: minToTime(dr.curStartMin + dr.durationMin) });
          }
          setTimeout(() => { didDragRef.current = false; }, 80);
        } else { didDragRef.current = false; }
        dragRef.current = null; setDragDisp(null);
      }
      if (rr) {
        const ev = weekEventsRef.current[rr.eventId] ?? eventsRef.current[rr.eventId];
        if (ev) {
          applyEditRef.current(rr.eventId, { startTime: minToTime(rr.startMin), endTime: minToTime(rr.endMin) });
        }
        resizeRef.current = null; setResizeDisp(null);
        setTimeout(() => { didDragRef.current = false; }, 80);
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
    createStamped(
      { id, dayIndex: dayIdx, startTime: minToTime(startMin), endTime: minToTime(startMin + dur), content: '', color: 'sage' },
      { edit: true, menuAt: { x: e.clientX + 10, y: e.clientY } },
    );
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
      additions[newId] = stampNewItem({ ...ev, id: newId, dayIndex: day, weekKey: wk, recur: undefined, exdates: undefined, masterId: undefined, occDate: undefined, gCalId: undefined, gCalCalendarId: undefined, gCalETag: undefined, gCalRecurSig: undefined, lastSyncedAt: undefined, deleted: undefined }, wk);
    }
    writeEvents({ ...eventsRef.current, ...additions });
    setMenuId(null); setMenuPos(null);
  };

  // ── Navigation ────────────────────────────────────────────────────────────
  const goBack  = () => { setDirection(-1); setCurrentDate(d => subWeeks(d, 1)); setEditingId(null); setMenuId(null); };
  const goNext  = () => { setDirection(1);  setCurrentDate(d => addWeeks(d, 1));  setEditingId(null); setMenuId(null); };
  const goToday = () => { setDirection(0);  setCurrentDate(new Date());            setEditingId(null); setMenuId(null); };
  // View-aware prev/next: one unit of whatever is currently on screen.
  const navStep = (dir: -1 | 1) => {
    setDirection(dir);
    setCurrentDate(d => {
      switch (calendarView) {
        case 'day':   return addDays(d, dir);
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

  // Ctrl+wheel steps along day → week → month → year.
  const stepCalendarZoom = useCallback((dir: -1 | 1) => {
    setDirection(0);
    setShowFocusAnalysis(false);
    setCalendarView(v => {
      const i = CALENDAR_VIEWS.indexOf(v);
      return CALENDAR_VIEWS[clamp(i + dir, 0, CALENDAR_VIEWS.length - 1)];
    });
    setEditingId(null);
    setMenuId(null);
  }, []);

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
    toggleView: () => { setDirection(0); setCalendarView(v => (v === 'week' ? 'month' : 'week')); },
    toggleAnalysis: () => setShowFocusAnalysis(v => !v),
    toggleSettings: () => setSettingsOpen(s => !s),
    openWidget: () => openWidget(),
    newEvent: () => { setShowFocusAnalysis(false); handleHeaderCreateClick(); },
    toggleTimer: () => { if (focusTimer.isRunning) pauseFocus(); else startFocus(); },
    toggleHelp: () => setShowShortcutHelp(v => !v),
  };

  // ── Ctrl+wheel = calendar zoom, Ctrl +/− = app zoom ───────────────────────
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
      if (now - wheelCooldown.t < 260) return;
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

  const commitZoomDraft = () => {
    const pct = parseInt(zoomDraft, 10);
    if (Number.isFinite(pct) && pct > 0) setAppZoom(clampZoom(pct / 100));
    else setZoomDraft(String(Math.round(appZoom * 100)));
    setEditingZoom(false);
  };

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
  // Anything that means "the user is in the middle of something" — a pushed
  // database change must wait rather than yank state out from under them.
  uiBusyRef.current = !!editingId || !!menuId || isDraggingAnything || isResizingAnything || !!draft;

  const surfaceBg  = darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.60)';
  const surfaceBdr = darkMode ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.12)';
  const hoverBg    = darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)';
  const menuBg     = darkMode ? '#1e2022' : '#ffffff';
  const menuBdr    = darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)';
  const menuText   = darkMode ? '#e8e8e8' : '#1a1a1a';
  const menuSub    = darkMode ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.40)';
  // Header control text — brighter than muted-foreground so it isn't washed out in dark mode.
  const headerLabel    = darkMode ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.50)';
  // Note: dark mode is driven entirely by these JS values. The stylesheet's
  // `.dark` class is never applied to the document, so any `var(--color-*)`
  // resolves to the *light* palette — a dark charcoal that all but disappears
  // against the dark background. Use these, never the CSS variables.
  const headerInactive = darkMode ? 'rgba(255,255,255,0.72)' : 'rgba(0,0,0,0.55)';
  // Now-line accent: a warmer, less harsh red on dark, a deeper one on light.
  const nowAccent     = darkMode ? '#ff6b6b' : '#e5484d';
  const nowAccentSoft = darkMode ? 'rgba(255,107,107,0.22)' : 'rgba(229,72,77,0.18)';

  // ── Current menu event (for popover rendering) ────────────────────────────
  const isDraft = !!(draft && menuId === draft.id);
  const menuEvent = isDraft ? draft : (menuId ? weekEvents[menuId] : null);

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

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      className={`min-h-screen bg-background text-foreground flex flex-col font-sans select-none${darkMode ? ' dark' : ''}`}
      // CSS `zoom` (not transform: scale) so the layout genuinely reflows and
      // fixed/sticky positioning keeps working — this replaces browser zoom.
      style={{ cursor: globalCursor, zoom: appZoom }}
    >
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-30 bg-background/85 backdrop-blur-md border-b border-border/50">
        <div className="max-w-[1400px] mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-5">
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
                      : format(calendarView === 'month' ? currentDate : weekStart, 'MMMM yyyy')}
                </span>
                <div className="flex items-center rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                  <button onClick={navPrev}  title={`Previous ${calendarView} (${formatCombo(shortcuts.prevWeek)})`} className="p-1.5 rounded-md text-muted-foreground transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}><ChevronLeft size={15}/></button>
                  <button onClick={goToday} title={`Jump to today (${formatCombo(shortcuts.today)})`} className="px-3 py-1 text-xs font-medium text-foreground/75 rounded-md transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}>Today</button>
                  <button onClick={navNext}  title={`Next ${calendarView} (${formatCombo(shortcuts.nextWeek)})`} className="p-1.5 rounded-md text-muted-foreground transition-colors" onMouseEnter={e=>(e.currentTarget.style.background=hoverBg)} onMouseLeave={e=>(e.currentTarget.style.background='transparent')}><ChevronRight size={15}/></button>
                </div>
                {/* Day / Week / Month / Year switch (also Ctrl+wheel) */}
                <div className="flex rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }} title="Ctrl + scroll to zoom between these">
                  {CALENDAR_VIEWS.map(v => {
                    const active = calendarView === v;
                    return (
                      <button key={v} onClick={() => { setDirection(0); setCalendarView(v); }} className="px-3 py-1 text-xs font-semibold rounded-md transition-all duration-200 capitalize"
                        style={{ background: active ? (darkMode ? 'rgba(255,255,255,0.14)' : '#fff') : 'transparent', color: active ? (darkMode ? '#f5f5f5' : menuText) : headerInactive, boxShadow: active ? '0 1px 3px rgba(0,0,0,0.15)' : 'none' }}>
                        {v}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => setDarkMode(d => !d)} title={darkMode ? 'Light mode' : 'Dark mode'} className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              {darkMode ? <Sun size={14}/> : <Moon size={14}/>}
            </button>
            {/* App zoom stepper — mirrors Ctrl +/− (Ctrl+0 resets). */}
            <div className="flex items-center rounded-lg shadow-sm overflow-hidden" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }} title="Zoom (Ctrl + / Ctrl − , Ctrl 0 to reset)">
              <button
                onClick={() => setAppZoom(z => clampZoom(z - ZOOM_STEP))}
                disabled={appZoom <= ZOOM_MIN + 1e-9}
                className="px-1.5 py-1 transition-colors disabled:opacity-30"
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
                  className="w-[38px] bg-transparent outline-none text-center text-[11px] font-semibold tabular-nums"
                  style={{ color: menuText }}
                />
              ) : (
                <button
                  onClick={() => { setZoomDraft(String(Math.round(appZoom * 100))); setEditingZoom(true); }}
                  className="w-[46px] text-[11px] font-semibold tabular-nums cursor-text"
                  style={{ color: menuText }}
                  title="Click to type an exact zoom %"
                >
                  {Math.round(appZoom * 100)}%
                </button>
              )}
              <button
                onClick={() => setAppZoom(z => clampZoom(z + ZOOM_STEP))}
                disabled={appZoom >= ZOOM_MAX - 1e-9}
                className="px-1.5 py-1 transition-colors disabled:opacity-30"
                style={{ color: headerInactive }}
                onMouseEnter={e => { if (!e.currentTarget.disabled) e.currentTarget.style.background = hoverBg; }}
                onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              >
                <Plus size={12}/>
              </button>
            </div>
            {!showFocusAnalysis && isTimelineView && (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-semibold uppercase tracking-widest" style={{ color: headerLabel }}>Interval</span>
                  <div className="flex rounded-lg p-0.5 shadow-sm" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
                    {([5, 15, 30, 60] as IntervalMin[]).map(v => (
                      <button key={v} onClick={() => setIntervalOpt(v)} className="px-3 py-1 text-xs font-semibold rounded-md transition-all duration-200"
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
            {/* Live sync indicator — quiet when idle, spins while syncing. */}
            <AnimatePresence>
              {gCalSyncing && (
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
            <button
              onClick={() => setShowFocusAnalysis(v => !v)}
              title={`${showFocusAnalysis ? 'Back to calendar' : 'Focus Analysis'} (${formatCombo(shortcuts.focusAnalysis)})`}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold transition-colors shadow-sm"
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
              onClick={handleHeaderCreateClick}
              title="Create Event"
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-blue-500 hover:bg-blue-600 transition-colors shadow-sm cursor-pointer"
            >
              <Plus size={14} />
              Create
            </button>
            <button onClick={openWidget} title="Open Floating Widget" className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors" style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}>
              <AppWindow size={14}/>
            </button>
            <button
              onClick={() => setShowShortcutHelp(true)}
              title={`Keyboard shortcuts (${formatCombo(shortcuts.help)})`}
              className="p-1.5 rounded-lg text-muted-foreground hover:text-foreground transition-colors"
              style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}` }}
            >
              <Keyboard size={14}/>
            </button>
            <button onClick={() => setSettingsOpen(s => !s)} title="Settings" className="p-1.5 rounded-lg transition-colors" style={{ background: settingsOpen ? (darkMode?'rgba(255,255,255,0.14)':'rgba(0,0,0,0.08)') : surfaceBg, border: `1px solid ${settingsOpen ? (darkMode?'rgba(255,255,255,0.22)':surfaceBdr) : surfaceBdr}`, color: settingsOpen ? menuText : headerInactive }}>
              <Settings size={14}/>
            </button>
          </div>
        </div>
      </header>

      {/* ── Grid ────────────────────────────────────────────────────────── */}
      <main ref={mainRef} className="flex-1 overflow-auto">
        <AnimatePresence mode="wait">
          {!showFocusAnalysis ? (
            <motion.div
              key="calendar-view-container"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
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
                  const active = isToday(day.day);
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
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
              >
                <AnimatePresence initial={false} custom={direction} mode="wait">
            <motion.div
              // Day view slides per day; week view per week.
              key={isDayView ? `d:${format(currentDate, 'yyyy-MM-dd')}` : `w:${weekStart.toISOString()}`}
              custom={direction}
              variants={{
                enter:  (d: number) => ({ x: d>0?14:d<0?-14:0, opacity: 0 }),
                center: { x: 0, opacity: 1 },
                exit:   (d: number) => ({ x: d<0?14:d>0?-14:0, opacity: 0 }),
              }}
              initial="enter" animate="center" exit="exit"
              // Snappy: holding the week keys should feel instant, not springy.
              transition={{ x: { type: 'spring', stiffness: 900, damping: 48, mass: 0.5 }, opacity: { duration: 0.07 } }}
              className="flex border border-border/60 rounded-xl overflow-hidden shadow-sm relative"
              style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.30)' }}
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
                  const day       = days[colIdx];
                  const today     = isToday(day);
                  // The column that actually contains "now" (see nowColIdx: before the
                  // day-start hour that's yesterday's column, not today's).
                  const isNowCol  = colIdx === nowColIdx;

                  // An event "spans the day boundary" when it starts before the configured
                  // day-start hour and ends after it (e.g. sleep from 1:15am to 9:45am with a
                  // 7am day cutoff) — it can't be drawn as one block in a single column, so it
                  // renders as a linked tail (in its own day) + head (in the next day) segment.
                  const isBoundarySpanning = (ev: PlannerEvent) => {
                    const s = timeToMin(ev.startTime);
                    const e = timeToMin(ev.endTime);
                    return s < dayStartMin && e >= dayStartMin;
                  };

                  type RenderItem = { ev: PlannerEvent; key: string; startMin: number; endMin: number; segKind: 'normal' | 'tail' | 'head' };
                  const renderItems: RenderItem[] = [];
                  for (const ev of Object.values(weekEvents)) {
                    if (ev.allDay) continue; // Skip all-day events in the timeline grid
                    
                    const isDrag      = dragDisp?.id === ev.id;
                    const isBatchDrag = !!(batchDisp && batchDisp[ev.id]);
                    const isDragging  = isDrag || isBatchDrag;
                    const isResizing  = resizeDisp?.id === ev.id;

                    if (isDragging) {
                      const dp = dispProps(ev);
                      // 1. Push a visual placeholder to the snapped column
                      if (dp.dayIndex === colIdx) {
                        renderItems.push({
                          ev: { ...ev, isPlaceholder: true } as PlannerEvent,
                          key: `${ev.id}__placeholder`,
                          startMin: dp.startMin,
                          endMin: dp.endMin,
                          segKind: 'normal'
                        });
                      }
                      
                      // 2. Push the original element to its original column so it can be translated
                      const startMinOrig = normalizeMin(timeToMin(ev.startTime), dayStartH);
                      let endMinOrig = normalizeMin(timeToMin(ev.endTime), dayStartH);
                      if (endMinOrig <= startMinOrig) endMinOrig += 1440;
                      if (ev.dayIndex === colIdx) {
                        renderItems.push({
                          ev,
                          key: ev.id,
                          startMin: startMinOrig,
                          endMin: endMinOrig,
                          segKind: 'normal'
                        });
                      }
                      continue;
                    }

                    if (isResizing) {
                      const dp = dispProps(ev);
                      if (dp.dayIndex === colIdx) {
                        renderItems.push({
                          ev,
                          key: ev.id,
                          startMin: dp.startMin,
                          endMin: dp.endMin,
                          segKind: 'normal'
                        });
                      }
                      continue;
                    }

                    if (isBoundarySpanning(ev)) {
                      if (ev.dayIndex === colIdx) {
                        renderItems.push({ ev, key: ev.id, startMin: timeToMin(ev.startTime) + 1440, endMin: dayEndMin, segKind: 'tail' });
                      }
                      if ((ev.dayIndex + 1) % 7 === colIdx) {
                        renderItems.push({ ev, key: `${ev.id}__head`, startMin: dayStartMin, endMin: timeToMin(ev.endTime), segKind: 'head' });
                      }
                      continue;
                    }
                    
                    const dp = dispProps(ev);
                    if (dp.dayIndex === colIdx) renderItems.push({ ev, key: ev.id, startMin: dp.startMin, endMin: dp.endMin, segKind: 'normal' });
                  }
                  const colEvents = renderItems;

                  // Compute parallel layout for this column, excluding placeholders to prevent shrinking
                  const layoutInput = colEvents
                    .filter(item => !(item.ev as any).isPlaceholder)
                    .map(item => ({ id: item.key, startMin: item.startMin, endMin: item.endMin }));
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
                              const sy = e.clientY - gr.top - HEADER_PX - allDayHeight;
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
                          const { bg, border, text } = colorPalette[ev.color];
                          const tooShort = height < sh * 2;
                          // Duration always reflects the event's true full start–end, not just this segment.
                          const fullStartMin = timeToMin(ev.startTime);
                          const fullEndMin   = timeToMin(ev.endTime);
                          const spansBoundary = fullStartMin < dayStartMin && fullEndMin >= dayStartMin;
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
                          // While a resize is in flight, the label tracks the dragged edges live
                          // (resizeDisp is already normalized against the day-start hour).
                          const durationMin = Math.max(0, resizeDisp?.id === ev.id
                            ? resizeDisp.endMin - resizeDisp.startMin
                            : spansBoundary
                              ? fullEndMin - fullStartMin
                              : normalizeMin(fullEndMin, dayStartH) - normalizeMin(fullStartMin, dayStartH));
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
                                cursor: isDrag ? 'grabbing' : isEdit ? 'text' : 'pointer',
                                opacity: isDrag ? 0.95 : 1,
                                // A touch more saturation on hover so the block "wakes up".
                                filter: lift ? 'saturate(1.12) brightness(1.03)' : undefined,
                                outline: isMenu ? `2px solid ${text}` : isSelected ? `2px solid ${darkMode ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.45)'}` : 'none',
                                outlineOffset: 1,
                                pointerEvents: (isMoving && !isResize) ? 'none' : undefined,
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
                              onDoubleClick={(e) => { e.stopPropagation(); openMenu(e, ev); enterEdit(ev.id); }}
                              onMouseEnter={() => setHoveredId(ev.id)}
                              onMouseLeave={() => setHoveredId(null)}
                            >
                              {/* Drag time tooltip */}
                              {isDrag && dragDisp && (
                                <div className="absolute z-50 pointer-events-none" style={{ top: -24, left: '50%', transform: 'translateX(-50%)' }}>
                                  <div className="text-[10px] font-semibold px-2 py-0.5 rounded whitespace-nowrap" style={{ background: text, color: bg, boxShadow: '0 2px 8px rgba(0,0,0,0.3)' }}>
                                    {formatTimeLabel(dragDisp.startMin, timeFormat)} – {formatTimeLabel(dragDisp.startMin + durationMin, timeFormat)}
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

                              {/* Continuation indicator (head segment: rest of event started the day before) */}
                              {segKind === 'head' && (
                                <div className="absolute top-0 left-0 right-0 flex items-center justify-center pointer-events-none" style={{ height: 10 }} title={`Continues from ${formatTimeLabel(fullStartMin, timeFormat)} the night before`}>
                                  <span style={{ fontSize: 9, lineHeight: 1, opacity: 0.55, color: text }}>⌃ continued</span>
                                </div>
                              )}

                              {/* Top resize handle */}
                              {segKind !== 'head' && (
                                <div className="absolute top-0 left-0 right-0 z-20 flex items-center justify-center" style={{ height: 10, cursor: 'n-resize', marginTop: -2 }} onMouseDown={(e) => handleResizeMouseDown(e, ev, 'top')}>
                                  <div className="rounded-full" style={{ width: 28, height: 3, backgroundColor: text, opacity: isHov||isEdit||isMenu ? 0.55 : 0.3, pointerEvents: 'none' }} />
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
                              <div className="absolute inset-0 px-2 pt-2.5 pb-2 flex flex-col overflow-hidden" style={{ top: 6, bottom: 8 }}>
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
                                        <span className="text-[9.5px] font-medium tabular-nums flex-shrink-0 mt-auto flex items-center gap-1" style={{ color: text, opacity: 0.45 }}>
                                          {formatTimeLabel(resizeDisp?.id === ev.id ? resizeDisp.startMin % 1440 : fullStartMin, timeFormat)} – {formatTimeLabel(resizeDisp?.id === ev.id ? resizeDisp.endMin % 1440 : fullEndMin, timeFormat)}
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

                              {/* Bottom resize handle */}
                              {segKind !== 'tail' && (
                                <div className="absolute bottom-0 left-0 right-0 z-20 flex items-center justify-center" style={{ height: 10, cursor: 's-resize', marginBottom: -2 }} onMouseDown={(e) => handleResizeMouseDown(e, ev, 'bottom')}>
                                  <div className="rounded-full" style={{ width: 28, height: 3, backgroundColor: text, opacity: isHov||isEdit||isMenu ? 0.55 : 0.3, pointerEvents: 'none' }} />
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
                    let leftPct: number;
                    let widthPct: number;
                    if (isDayView) {
                      if (dayViewColIdx < startIdx || dayViewColIdx >= startIdx + span) return null;
                      leftPct = 0;
                      widthPct = 100;
                    } else {
                      leftPct = (startIdx / 7) * 100;
                      widthPct = (span / 7) * 100;
                    }

                    const isEdit = editingId === ev.id;
                    const isSelected = selectedIds.has(ev.id);
                    const isMenu = menuId === ev.id;
                    const { bg, border, text } = colorPalette[ev.color];

                    // Find actual day date string of start day
                    const startDayDate = days[ev.dayIndex];
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
                    top: HEADER_PX + allDayHeight + selRect.top,
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
                        top: HEADER_PX + allDayHeight + 90,
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
        /* ── Year overview ──────────────────────────────────────────── */
        (() => {
        const yearMaxDayCount = Math.max(1, ...yearMatrix.flatMap(m => m.cells.map(c => c.count)));
        return (
        <motion.div
          key="year-view-wrapper"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-xl border border-border/60 overflow-hidden shadow-sm p-4"
          style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.30)' }}
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
                    const isTodayCell = isToday(c.date);
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
        /* ── Month overview ─────────────────────────────────────────── */
        <motion.div
          key="month-view-wrapper"
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="rounded-xl border border-border/60 overflow-hidden shadow-sm"
          style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(255,255,255,0.30)' }}
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
            {monthMatrix.map(week => (
              <div key={week.weekKey} className="grid grid-cols-7 border-b border-border/40 last:border-b-0">
                {week.cells.map(({ date, events: cellEvents }) => {
                  const inMonth = isSameMonth(date, currentDate);
                  const cellToday = isToday(date);
                  // Tint the cell by how much focus time it holds — the month grid
                  // doubles as a heatmap of where the deep work actually landed.
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
                  // All-day items read as banners and sort above the timed ones.
                  const ordered = [...cellEvents].sort((a, b) => Number(!!b.allDay) - Number(!!a.allDay));
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
                      {/* Today gets a real marker, not just a faint tint */}
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
                          {ordered.length > 0 && <span className="text-[8.5px] tabular-nums" style={{ color: menuSub }}>{ordered.length}</span>}
                        </span>
                      </div>
                      <div className="flex flex-col gap-0.5 overflow-hidden">
                        {ordered.slice(0, 4).map(ev => {
                          const { bg, border, text } = colorPalette[ev.color];
                          const label = ev.allDay ? 'All day' : formatTimeLabel(timeToMin(ev.startTime), timeFormat);
                          return (
                            <div
                              key={ev.id}
                              className="rounded px-1 py-0.5 truncate text-[9px] font-medium leading-tight transition-transform duration-150 hover:translate-x-[1px]"
                              style={{
                                background: bg,
                                // All-day items get a full outline so they read as banners.
                                border: ev.allDay ? `1px solid ${border}` : undefined,
                                borderLeft: `2px solid ${border}`,
                                color: text,
                              }}
                              title={`${label} ${ev.content}`}
                            >
                              <span className="tabular-nums opacity-80">{label}</span>{ev.content ? ` ${ev.content}` : ''}
                            </div>
                          );
                        })}
                        {ordered.length > 4 && <span className="text-[8.5px] pl-1" style={{ color: menuSub }}>+{ordered.length - 4} more</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
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
                        className="px-2 py-1 text-[13px] leading-none transition-colors"
                        style={{ color: menuSub }}
                        onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >−</button>
                      <span className="px-2 py-1 text-[11px] font-semibold tabular-nums min-w-[52px] text-center" style={{ color: menuText }}>
                        {`${focusDayStartHour % 12 === 0 ? 12 : focusDayStartHour % 12} ${focusDayStartHour < 12 ? 'AM' : 'PM'}`}
                      </span>
                      <button
                        onClick={() => setFocusDayStartHour(h => (h + 1) % 24)}
                        className="px-2 py-1 text-[13px] leading-none transition-colors"
                        style={{ color: menuSub }}
                        onMouseEnter={e => (e.currentTarget.style.background = hoverBg)}
                        onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      >+</button>
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
                        const isTodayCol = isToday(d.date);
                        const isBest = d.seconds > 0 && d.key === weekAnalysisLive.bestKey;
                        return (
                          <div key={d.key} className="flex-1 h-full flex flex-col justify-end gap-1 min-w-0">
                            {/* Exact time above each bar */}
                            <div className="text-[10px] font-bold tabular-nums text-center truncate"
                                 style={{ color: d.seconds > 0 ? (isTodayCol ? '#60a5fa' : menuText) : menuSub, opacity: d.seconds > 0 ? 1 : 0.5 }}>
                              {d.seconds > 0 ? formatFocusDuration(d.seconds) : '—'}
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

                    {/* Exact per-day breakdown */}
                    <div className="mt-4 rounded-xl overflow-hidden" style={{ border: `1px solid ${surfaceBdr}` }}>
                      {weekAnalysisLive.days.map((d, i) => (
                        <div
                          key={d.key}
                          className="flex items-center justify-between px-3.5 py-2 text-xs"
                          style={{
                            background: isToday(d.date)
                              ? (darkMode ? 'rgba(96,165,250,0.10)' : 'rgba(37,99,235,0.06)')
                              : i % 2 === 0 ? surfaceBg : 'transparent',
                            borderTop: i === 0 ? 'none' : `1px solid ${surfaceBdr}`,
                          }}
                        >
                          <span className="font-medium flex items-center gap-1.5" style={{ color: isToday(d.date) ? '#60a5fa' : menuText }}>
                            <Clock size={11} style={{ opacity: 0.5 }} />
                            {format(d.date, 'EEEE, MMM d')}
                            {isToday(d.date) && <span className="text-[9px] font-bold uppercase tracking-wider">Today</span>}
                          </span>
                          <span className="tabular-nums flex items-center gap-2" style={{ color: d.seconds > 0 ? menuText : menuSub }}>
                            <span className="font-semibold">{formatFocusDuration(d.seconds)}</span>
                            <span style={{ color: menuSub }}>· {d.sessions} session{d.sessions === 1 ? '' : 's'}</span>
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
                        const todayCell = isSameDay(d, nowDate);
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
                              className="text-[15px] font-bold tabular-nums leading-none"
                              style={{ color: secs > 0 ? (hot ? '#fff' : '#60a5fa') : menuSub, opacity: secs > 0 ? 1 : 0.45 }}
                            >
                              {secs > 0 ? formatFocusDuration(secs) : '—'}
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

      {/* ── Keyboard shortcut help overlay ───────────────────────────────── */}
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
                    Rebind any of these in <span style={{ color: menuText }}>Settings → Keyboard Shortcuts</span>.
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

      {/* ── Toasts ───────────────────────────────────────────────────────── */}
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

      {/* Floating "Go to Live" button — appears when the red now-line is off-screen. */}
      <AnimatePresence>
        {showLiveBtn && isTimelineView && (
          <motion.button
            key="go-to-live"
            onClick={scrollToLive}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[120] flex items-center gap-1.5 px-4 py-2.5 rounded-full text-xs font-semibold shadow-lg backdrop-blur-md active:scale-95"
            style={{
              background: darkMode ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.70)',
              border: `1px solid ${darkMode ? 'rgba(255, 255, 255, 0.20)' : 'rgba(0, 0, 0, 0.10)'}`,
              color: '#ffffff',
            }}
          >
            <Clock size={12} />
            Go to Live
          </motion.button>
        )}
      </AnimatePresence>

      {/* ── Settings drawer ─────────────────────────────────────────────── */}
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
                        Link Google Account
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

      {/* ── Context menu (portal-style fixed popover) ────────────────────── */}
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

          {/* Color picker */}
          <div className="px-3 py-2.5 flex items-center gap-2" style={{ borderBottom: `1px solid ${menuBdr}` }}>
            <span className="text-[9px] font-bold uppercase tracking-wider mr-1" style={{ color: menuSub }}>Color</span>
            {SWATCHES.map(c => {
              const sc = colorPalette[c];
              return (
                <button key={c} type="button"
                  onClick={() => applyEdit(menuEvent.id, { color: c })}
                  className="rounded-full border transition-transform hover:scale-110"
                  style={{ width: 15, height: 15, backgroundColor: sc.bg, borderColor: sc.border, outline: menuEvent.color===c ? `2px solid ${sc.text}` : 'none', outlineOffset: 1 }}
                />
              );
            })}
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
