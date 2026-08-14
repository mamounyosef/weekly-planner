import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ArrowLeft,
  Sun,
  Moon,
  Clock,
  Calendar,
  Volume2,
  Keyboard,
  Database,
  RefreshCw,
  Download,
  Upload,
  Check,
  X,
  Sliders,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Link2,
  Link2Off,
  ShieldCheck,
  RotateCcw,
  Zap,
  Compass,
  Cpu,
} from 'lucide-react';
import {
  FOCUS_CHIMES,
  FOCUS_CUES,
  FocusChimeId,
  FocusCueSlot,
  FocusCueId,
  playFocusChime,
  playFocusCue,
  coerceFocusChime,
  coerceFocusCue,
} from '@/lib/focusSessions';
import {
  SHORTCUT_DEFS,
  DEFAULT_SHORTCUTS,
  ShortcutAction,
  ShortcutMap,
  loadShortcuts,
  findConflicts,
  formatCombo,
  eventToCombo,
  isReservedCombo,
  coerceShortcuts,
} from '@/lib/shortcuts';

import {
  PRAYER_KEYS,
  PRAYER_LABELS,
  PRAYER_METHODS,
  PRAYER_HORIZON_MIN,
  PRAYER_HORIZON_MAX,
  buildPrayerDay,
  prayerDateKey,
  prayerMonthUrl,
  type PrayerDayTimes,
  type PrayerKey,
  type PrayerSettings,
  type PrayerStyle,
} from '@/lib/prayerTimes';
import { DEFAULT_HARDWARE_SETTINGS, MEDIAN_WINDOW_MAX, type HardwareSettings } from '@/lib/hardwareController';
import { NumberField } from '@/components/NumberField';
import { useViewport } from '@/hooks/use-mobile';
import {
  DEVICE_SCOPED_KEYS,
  coerceDeviceSettings,
  fetchDeviceSettings,
  loadDeviceSettingsLocal,
  saveDeviceSettings,
  subscribeDeviceSettings,
} from '@/lib/deviceSettings';
import {
  broadcastSettingsChange,
  subscribeSettingsChange,
  loadSettingsLocal,
  applyDarkModeClass,
  coerceSettings,
  themePalette,
  DARK_PRESETS,
  DEFAULT_SETTINGS,
  LIGHT_PRESETS,
  type AppSettings,
  type DarkPreset,
  type LightPreset,
  type EventCardStyle,
  type SidebarStyle,
  type TaskCheckboxShape,
} from '@/lib/settingsSync';

type TimeFormat = '12h' | '24h';
type IntervalMin = 5 | 15 | 30 | 60;
type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface AutoBackupCfg {
  enabled: boolean;
  intervalHours: number;
  keep: number;
}

const AUTO_BACKUP_DEFAULT: AutoBackupCfg = { enabled: true, intervalHours: 24, keep: 50 };

/**
 * The exact strings Google demands in "Authorized redirect URIs".
 *
 * Google matches redirect_uri EXACTLY — scheme, host, port, path, trailing
 * slash — and `http://localhost:5173` and `http://127.0.0.1:5173` are two
 * different entries. This planner is opened under BOTH (the main window on
 * localhost, the side widget on 127.0.0.1), so registering only one produces
 * "Error 400: redirect_uri_mismatch" the moment you connect from the other.
 * Rather than explaining that, show both and let them be copied.
 */
function RedirectUriHelp({ textPrimary, textSecondary, cardBdr, darkMode, onCopied }: {
  textPrimary: string;
  textSecondary: string;
  cardBdr: string;
  darkMode: boolean;
  onCopied: () => void;
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  let uris: string[] = [origin];
  try {
    const u = new URL(origin);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      const port = u.port ? `:${u.port}` : '';
      uris = [`${u.protocol}//localhost${port}`, `${u.protocol}//127.0.0.1${port}`];
    }
  } catch (_) {}

  return (
    <div className="p-3 rounded-xl border flex flex-col gap-2" style={{ borderColor: cardBdr, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)' }}>
      <span className="text-[11px] font-bold" style={{ color: textPrimary }}>
        First: authorise these redirect URIs
      </span>
      <p className="text-[10.5px] leading-snug" style={{ color: textSecondary }}>
        In Google Cloud Console → APIs &amp; Services → Credentials → your OAuth client →
        <b> Authorized redirect URIs</b>, add both of these exactly. Google compares them
        character for character, and this app runs under both host names (the main window
        uses localhost, the side widget uses 127.0.0.1). Missing one is what causes
        “Error 400: redirect_uri_mismatch”.
      </p>
      <div className="flex flex-col gap-1.5">
        {uris.map(u => (
          <button
            key={u}
            type="button"
            onClick={() => { navigator.clipboard?.writeText(u).then(onCopied, () => {}); }}
            className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-colors"
            style={{ borderColor: cardBdr, background: darkMode ? 'rgba(0,0,0,0.25)' : '#fff' }}
            title="Copy"
          >
            <code className="text-[11px] font-mono truncate" style={{ color: textPrimary }}>{u}</code>
            <span className="text-[10px] font-semibold flex-shrink-0" style={{ color: textSecondary }}>Copy</span>
          </button>
        ))}
      </div>
      <p className="text-[10px] leading-snug" style={{ color: textSecondary }}>
        Also check <b>OAuth consent screen → Publishing status</b>. While an app is in
        <b> Testing</b>, Google expires its refresh tokens after 7 days — sync then dies
        every week until you press Publish.
      </p>
    </div>
  );
}

/**
 * Live distance readout plus a two-sample calibration.
 *
 * Thresholds cannot be guessed: they depend on where the sensor ended up, the
 * chair, and how you sit. Capturing what the sensor genuinely reports in each
 * state and deriving the thresholds from that is the only way to get a gap
 * that actually separates them — and it makes an unworkable placement (the two
 * readings overlapping) immediately obvious instead of a mystery later.
 */
function HardwareCalibration({ hardware, patchHardware, cardBg, cardBdr, textPrimary, textSecondary }: {
  hardware: HardwareSettings;
  patchHardware: (patch: Partial<HardwareSettings>) => void;
  cardBg: string;
  cardBdr: string;
  textPrimary: string;
  textSecondary: string;
}) {
  const [live, setLive] = useState<number | null>(null);
  const [livePresent, setLivePresent] = useState<boolean | null>(null);
  const [seated, setSeated] = useState<number | null>(null);
  const [empty, setEmpty] = useState<number | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // Polled whenever this section is open, not just while calibrating: seeing
  // the number the sensor is actually producing is the fastest way to tell a
  // placement problem from a threshold problem.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/hardware/live');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        setLive(typeof data?.distanceCm === 'number' ? data.distanceCm : null);
        setLivePresent(typeof data?.present === 'boolean' ? data.present : null);
      } catch (_) { /* transient */ }
    };
    void tick();
    const id = window.setInterval(() => { void tick(); }, hardware.calibrating ? 300 : 1000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, [hardware.calibrating]);

  const apply = (seatedCm: number, emptyCm: number) => {
    if (seatedCm >= emptyCm) {
      setNote('Seated reads no closer than empty — the sensor is aimed at something fixed (a chair back or armrest). Re-aim it and capture again.');
      return;
    }
    const gap = emptyCm - seatedCm;
    if (gap < 10) {
      setNote(`Only ${gap.toFixed(0)} cm between the two states. That is too narrow to be reliable — re-aim for a clearer gap.`);
      return;
    }
    // Thresholds placed inside the gap rather than at its centre: the band
    // between them is the hysteresis, and biasing it slightly towards "empty"
    // makes the sensor quicker to notice you than to give up on you.
    patchHardware({
      enterCm: Math.round(seatedCm + gap * 0.45),
      exitCm: Math.round(seatedCm + gap * 0.65),
      calibrating: false,
    });
    setNote(`Done — ${gap.toFixed(0)} cm of separation. Thresholds set and calibration turned off.`);
  };

  return (
    <div className="rounded-2xl border p-4 flex flex-col gap-3" style={{ borderColor: cardBdr }}>
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Calibration</span>
        <button
          type="button"
          onClick={() => {
            patchHardware({ calibrating: !hardware.calibrating });
            setSeated(null); setEmpty(null); setNote(null);
          }}
          className="px-3 py-1.5 rounded-lg border text-[11px]"
          style={{
            background: hardware.calibrating ? '#3b82f6' : cardBg,
            borderColor: hardware.calibrating ? '#3b82f6' : cardBdr,
            color: hardware.calibrating ? '#fff' : textPrimary,
          }}
        >
          {hardware.calibrating ? 'Stop' : 'Start calibration'}
        </button>
      </div>

      {/* Live readout, shown whether or not calibration is running */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className="text-2xl font-semibold tabular-nums" style={{ color: textPrimary }}>
            {live === null ? '--' : live.toFixed(1)}
          </span>
          <span className="text-[11px]" style={{ color: textSecondary }}>
            {live === null ? 'board not reporting' : 'cm'}
          </span>
        </div>
        {live !== null && livePresent !== null && (
          <span
            className="px-2 py-1 rounded-lg text-[10px] font-semibold"
            style={{
              background: livePresent ? 'rgba(34,197,94,0.15)' : 'rgba(148,163,184,0.15)',
              color: livePresent ? '#22c55e' : textSecondary,
            }}
          >
            {livePresent ? 'AT DESK' : 'AWAY'}
          </span>
        )}
      </div>
      {live !== null && (
        <p className="text-[10px] -mt-1" style={{ color: textSecondary }}>
          Counts as at the desk below {hardware.enterCm}cm, as away above {hardware.exitCm}cm; in between it holds
          whatever it already decided.
        </p>
      )}

      {hardware.calibrating ? (
        <>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              disabled={live === null}
              onClick={() => { setSeated(live); setNote(null); }}
              className="px-3 py-2 rounded-xl border text-[11px] disabled:opacity-40"
              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
            >
              Capture seated{seated !== null ? ` · ${seated.toFixed(0)}cm` : ''}
            </button>
            <button
              type="button"
              disabled={live === null}
              onClick={() => { setEmpty(live); setNote(null); }}
              className="px-3 py-2 rounded-xl border text-[11px] disabled:opacity-40"
              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
            >
              Capture empty{empty !== null ? ` · ${empty.toFixed(0)}cm` : ''}
            </button>
          </div>

          <p className="text-[10px]" style={{ color: textSecondary }}>
            Sit normally and capture seated. Then get up, step away, and capture empty — leave the chair where it
            normally sits, since it stays in the beam when you go.
          </p>

          <button
            type="button"
            disabled={seated === null || empty === null}
            onClick={() => { if (seated !== null && empty !== null) apply(seated, empty); }}
            className="px-3 py-2 rounded-xl text-[11px] font-semibold disabled:opacity-40"
            style={{ background: '#3b82f6', color: '#fff' }}
          >
            Set thresholds from these readings
          </button>
        </>
      ) : (
        <p className="text-[10px]" style={{ color: textSecondary }}>
          Streams live distance from the sensor so the thresholds can be measured rather than guessed.
        </p>
      )}

      {note && (
        <p className="text-[10px] leading-relaxed" style={{ color: textSecondary }}>{note}</p>
      )}
    </div>
  );
}

/**
 * Today's calculated times, live from the same cache the calendar uses. This is
 * the only honest way to check a method/offset change — you compare these six
 * numbers against your mosque, not a description of an algorithm.
 */
function PrayerTodayPreview({ prayer, textPrimary, textSecondary, cardBdr, darkMode }: {
  prayer: PrayerSettings;
  textPrimary: string;
  textSecondary: string;
  cardBdr: string;
  darkMode: boolean;
}) {
  const [state, setState] = useState<{ status: 'loading' | 'ok' | 'error'; times?: PrayerDayTimes; stale?: boolean; message?: string }>({ status: 'loading' });
  const now = new Date();

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    const d = new Date();
    fetch(prayerMonthUrl(prayer, d.getFullYear(), d.getMonth() + 1))
      .then(async r => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || `Server responded ${r.status}`);
        return body;
      })
      .then(body => {
        if (cancelled) return;
        const today = body?.days?.[prayerDateKey(new Date())];
        if (!today) throw new Error('No times returned for today');
        setState({ status: 'ok', times: today, stale: !!body.stale });
      })
      .catch(err => {
        if (!cancelled) setState({ status: 'error', message: String(err?.message || err) });
      });
    return () => { cancelled = true; };
  }, [prayer.city, prayer.country, prayer.method, prayer.school]);

  const occurrences = state.times ? buildPrayerDay(prayerDateKey(now), state.times, prayer) : [];

  return (
    <div className="p-4 rounded-2xl border flex flex-col gap-2" style={{ borderColor: cardBdr, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)' }}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold" style={{ color: textSecondary }}>
          Today in {prayer.city}
        </span>
        {state.stale && (
          <span className="text-[10px] font-semibold" style={{ color: '#f59e0b' }}>cached — API unreachable</span>
        )}
      </div>
      {state.status === 'loading' && (
        <span className="text-xs" style={{ color: textSecondary }}>Loading…</span>
      )}
      {state.status === 'error' && (
        <span className="text-xs" style={{ color: '#ef4444' }}>
          Couldn't load times for “{prayer.city}, {prayer.country}” — check the spelling. ({state.message})
        </span>
      )}
      {state.status === 'ok' && (
        <div className="flex items-center gap-3 flex-wrap">
          {occurrences.map(o => (
            <span key={o.key} className="flex flex-col">
              <span className="text-[10px]" style={{ color: textSecondary }}>{o.label}</span>
              <span className="text-sm font-bold tabular-nums" style={{ color: textPrimary }}>{o.time}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * The background-theme picker. Each tile paints itself in the theme it selects,
 * so the grid is a live preview rather than a list of names. Used for both the
 * main window and the side window, which keep separate choices.
 */
function BackgroundPresetGrid({ dark, value, onChange, cardBdr }: {
  dark: boolean;
  value: string;
  onChange: (id: string) => void;
  cardBdr: string;
}) {
  const presets = dark ? DARK_PRESETS : LIGHT_PRESETS;
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {presets.map(preset => {
        const selected = value === preset.id;
        return (
          <button
            key={preset.id}
            onClick={() => onChange(preset.id)}
            className="p-3.5 rounded-2xl border text-left flex flex-col gap-2 transition-all relative overflow-hidden cursor-pointer hover:scale-[1.02]"
            style={{
              background: preset.rootBg,
              borderColor: selected ? '#3b82f6' : cardBdr,
              boxShadow: selected ? '0 0 0 2px rgba(59,130,246,0.4)' : 'none',
            }}
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold" style={{ color: dark ? '#f1f5f9' : '#1e293b' }}>{preset.label}</span>
              {selected && <Check size={14} style={{ color: '#3b82f6' }} />}
            </div>
            <span className="text-[10px] leading-snug" style={{ color: dark ? 'rgba(255,255,255,0.5)' : '#64748b' }}>
              {preset.desc}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function coerceAutoBackup(raw: unknown): AutoBackupCfg {
  const cfg = { ...AUTO_BACKUP_DEFAULT };
  if (!raw || typeof raw !== 'object') return cfg;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled === 'boolean') cfg.enabled = r.enabled;
  if (typeof r.intervalHours === 'number' && Number.isFinite(r.intervalHours)) {
    cfg.intervalHours = Math.max(1, Math.min(168, Math.round(r.intervalHours)));
  }
  if (typeof r.keep === 'number' && Number.isFinite(r.keep)) {
    cfg.keep = Math.max(1, Math.min(1000, Math.round(r.keep)));
  }
  return cfg;
}

type TabCategory = 'appearance' | 'calendar' | 'prayer' | 'audio' | 'shortcuts' | 'backup' | 'integrations' | 'hardware';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export default function SettingsPage() {
  const [, setLocation] = useLocation();
  // Settings is a two-column layout with a 256px sidebar — on a phone that
  // leaves ~130px for the controls themselves, so the sidebar becomes a
  // horizontally scrolling strip of chips above the content instead.
  const vp = useViewport();
  const isPhone = vp.isPhone;

  // Active Sidebar Tab
  // `?tab=integrations` deep-links a section — the header's "Google disconnected"
  // pill sends you straight to the connection controls rather than dumping you on
  // the appearance tab to go hunting.
  const [activeTab, setActiveTab] = useState<TabCategory>(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get('tab');
      const known: string[] = ['appearance', 'calendar', 'prayer', 'audio', 'shortcuts', 'backup', 'integrations', 'hardware'];
      if (requested && known.includes(requested)) return requested as TabCategory;
    } catch (_) {}
    return 'appearance';
  });

  // Initialize state from local settings cache for instant display
  const initialSettings = useRef(loadSettingsLocal()).current;

  // Settings states
  const [interval, setIntervalOpt] = useState<IntervalMin>(initialSettings.interval);
  const [darkMode, setDarkMode] = useState<boolean>(initialSettings.darkMode);
  const [darkPreset, setDarkPreset] = useState<DarkPreset>(initialSettings.darkPreset);
  const [lightPreset, setLightPreset] = useState<LightPreset>(initialSettings.lightPreset);
  // The side window keeps its own background theme; every other appearance
  // setting on this page applies to both windows.
  const [widgetDarkPreset, setWidgetDarkPreset] = useState<DarkPreset>(initialSettings.widgetDarkPreset);
  const [widgetLightPreset, setWidgetLightPreset] = useState<LightPreset>(initialSettings.widgetLightPreset);
  // Owned by the main window. Carried here purely so saving from this page never
  // resets which view the planner was on.
  const [calendarView, setCalendarView] = useState<string | undefined>(initialSettings.calendarView);
  const [customDaysBefore, setCustomDaysBefore] = useState<number>(initialSettings.customDaysBefore);
  const [customDaysAfter, setCustomDaysAfter] = useState<number>(initialSettings.customDaysAfter);
  const [eventColorStyle, setEventColorStyle] = useState<EventCardStyle>(initialSettings.eventColorStyle);
  const [sidebarStyle, setSidebarStyle] = useState<SidebarStyle>(initialSettings.sidebarStyle);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(initialSettings.timeFormat);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(initialSettings.weekStartsOn);
  const [dayStartH, setDayStartH] = useState<number>(initialSettings.dayStartH);
  const [dayEndH, setDayEndH] = useState<number>(initialSettings.dayEndH);
  const [focusDayStartHour, setFocusDayStartHour] = useState<number>(initialSettings.focusDayStartHour);
  const [focusChime, setFocusChime] = useState<FocusChimeId>(initialSettings.focusChime);
  const [focusCues, setFocusCues] = useState<{ start: FocusCueId; pause: FocusCueId; resume: FocusCueId }>(initialSettings.focusCues);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(initialSettings.shortcuts);
  const [autoBackup, setAutoBackup] = useState<AutoBackupCfg>(initialSettings.autoBackup);
  // Tasks. `tasksPanelOpen`/`tasksPanelWidth`/`taskFilters` are owned by the main
  // window — carried here only so saving from this page never resets them.
  const [tasksPanelOpen, setTasksPanelOpen] = useState<boolean>(initialSettings.tasksPanelOpen);
  const [tasksPanelWidth, setTasksPanelWidth] = useState<number>(initialSettings.tasksPanelWidth);
  const [taskFilters, setTaskFilters] = useState<string[]>(initialSettings.taskFilters);
  const [showTaskRow, setShowTaskRow] = useState<boolean>(initialSettings.showTaskRow);
  const [taskColor, setTaskColor] = useState<string>(initialSettings.taskColor);
  const [taskCheckboxShape, setTaskCheckboxShape] = useState<TaskCheckboxShape>(initialSettings.taskCheckboxShape ?? 'circle');
  const [googleSyncEnabled, setGoogleSyncEnabled] = useState<boolean>(initialSettings.googleSyncEnabled ?? true);
  const [googleTasksSync, setGoogleTasksSync] = useState<boolean>(initialSettings.googleTasksSync);
  const [stickyAllDayMain, setStickyAllDayMain] = useState<boolean>(initialSettings.stickyAllDayMain ?? true);
  const [stickyTasksMain, setStickyTasksMain] = useState<boolean>(initialSettings.stickyTasksMain ?? true);
  const [stickyAllDayWidget, setStickyAllDayWidget] = useState<boolean>(initialSettings.stickyAllDayWidget ?? true);
  const [stickyTasksWidget, setStickyTasksWidget] = useState<boolean>(initialSettings.stickyTasksWidget ?? true);
  const [gcalPushEnabled, setGcalPushEnabled] = useState<boolean>(initialSettings.gcalPushEnabled ?? true);
  const [gcalPushTarget, setGcalPushTarget] = useState<'daily' | 'primary'>(initialSettings.gcalPushTarget ?? 'daily');
  const [gcalPushOtherCalendars, setGcalPushOtherCalendars] = useState<boolean>(initialSettings.gcalPushOtherCalendars ?? true);
  const [gcalPullDailyEdits, setGcalPullDailyEdits] = useState<boolean>(initialSettings.gcalPullDailyEdits ?? false);
  const [gcalPullDailyNew, setGcalPullDailyNew] = useState<boolean>(initialSettings.gcalPullDailyNew ?? false);
  const [gcalPullOtherCalendars, setGcalPullOtherCalendars] = useState<boolean>(initialSettings.gcalPullOtherCalendars ?? true);
  const [gcalMirrorLocalDeletions, setGcalMirrorLocalDeletions] = useState<boolean>(initialSettings.gcalMirrorLocalDeletions ?? true);
  const [gcalMirrorGoogleDeletions, setGcalMirrorGoogleDeletions] = useState<boolean>(initialSettings.gcalMirrorGoogleDeletions ?? false);
  const [prayer, setPrayer] = useState<PrayerSettings>(initialSettings.prayer);
  const [hardware, setHardware] = useState<HardwareSettings>(initialSettings.hardware);
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);
  const patchPrayer = useCallback((patch: Partial<PrayerSettings>) => {
    setPrayer(prev => ({ ...prev, ...patch }));
  }, []);
  const patchHardware = useCallback((patch: Partial<HardwareSettings>) => {
    setHardware(prev => ({ ...prev, ...patch }));
  }, []);

  // Backup status state
  const [backupStatus, setBackupStatus] = useState<{ count: number; lastBackupAt: string | null } | null>(null);

  // Google Calendar Auth state
  const [gCalStatus, setGCalStatus] = useState<{
    configured: boolean;
    authenticated: boolean;
    autoSync: boolean;
    email?: string;
    clientId?: string;
    clientSecret?: string;
    hasTasksScope?: boolean;
  }>({ configured: false, authenticated: false, autoSync: true });
  const [clientIdInput, setClientIdInput] = useState('');
  const [clientSecretInput, setClientSecretInput] = useState('');
  const [gCalSyncing, setGCalSyncing] = useState(false);

  // Toast System
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastSeq = useRef(0);

  const showToast = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = ++toastSeq.current;
    setToasts(prev => [...prev.slice(-2), { id, message, tone }]);
    window.setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4200);
  }, []);

  const settingsLoaded = useRef(true);

  // ── This device's own settings ───────────────────────────────────────────
  // Mirrors home.tsx: the keys that describe THIS screen are read from and
  // written to the per-device store, never to the shared settings file.
  const sharedScopedRef = useRef<Pick<AppSettings, typeof DEVICE_SCOPED_KEYS[number]>>({
    calendarView: initialSettings.calendarView,
    customDaysBefore: initialSettings.customDaysBefore,
    customDaysAfter: initialSettings.customDaysAfter,
    interval: initialSettings.interval,
    tasksPanelOpen: initialSettings.tasksPanelOpen,
    tasksPanelWidth: initialSettings.tasksPanelWidth,
    showTaskRow: initialSettings.showTaskRow,
    stickyAllDayMain: initialSettings.stickyAllDayMain,
    stickyTasksMain: initialSettings.stickyTasksMain,
    darkMode: initialSettings.darkMode,
    darkPreset: initialSettings.darkPreset,
    lightPreset: initialSettings.lightPreset,
    eventColorStyle: initialSettings.eventColorStyle,
    sidebarStyle: initialSettings.sidebarStyle,
    dayStartH: initialSettings.dayStartH,
    dayEndH: initialSettings.dayEndH,
  });

  /** Adopt a device snapshot into the live controls. */
  const applyDevice = useCallback((raw: unknown) => {
    const d = coerceDeviceSettings(raw, { ...DEFAULT_SETTINGS, ...sharedScopedRef.current });
    setIntervalOpt(d.interval);
    setDarkMode(d.darkMode);
    setDarkPreset(d.darkPreset);
    setLightPreset(d.lightPreset);
    setEventColorStyle(d.eventColorStyle);
    setSidebarStyle(d.sidebarStyle);
    setCalendarView(d.calendarView);
    setCustomDaysBefore(d.customDaysBefore);
    setCustomDaysAfter(d.customDaysAfter);
    setDayStartH(d.dayStartH);
    setDayEndH(d.dayEndH);
    setTasksPanelOpen(d.tasksPanelOpen);
    setTasksPanelWidth(d.tasksPanelWidth);
    setShowTaskRow(d.showTaskRow);
    setStickyAllDayMain(d.stickyAllDayMain);
    setStickyTasksMain(d.stickyTasksMain);
    deviceExtrasRef.current = { appZoom: d.appZoom, analysisTab: d.analysisTab, mobileTab: d.mobileTab };
  }, []);
  /** Device-only values this page has no control for, carried through untouched. */
  const deviceExtrasRef = useRef({ appZoom: 1, analysisTab: 'week' as const as 'week' | 'month' | 'year', mobileTab: 'calendar' as const as 'calendar' | 'tasks' | 'focus' });
  const deviceReady = useRef(false);

  // Load this device's stored layout: localStorage first (instant), then the
  // server, which is authoritative and survives a cleared cache.
  useEffect(() => {
    applyDevice(loadDeviceSettingsLocal());
    let cancelled = false;
    fetchDeviceSettings().then(remote => {
      if (!cancelled && remote) applyDevice(remote);
    }).finally(() => { deviceReady.current = true; });
    return () => { cancelled = true; };
  }, [applyDevice]);

  // Adopt changes made on the planner page (it owns the same values).
  useEffect(() => subscribeDeviceSettings(raw => applyDevice(raw)), [applyDevice]);

  // Publish this page's changes back. Debounced inside saveDeviceSettings, and
  // a write identical to the last one is dropped — so this and the planner
  // page settle instead of answering each other.
  useEffect(() => {
    if (!deviceReady.current) return;
    saveDeviceSettings({
      calendarView: calendarView ?? 'week',
      customDaysBefore, customDaysAfter, interval,
      tasksPanelOpen, tasksPanelWidth, showTaskRow,
      stickyAllDayMain, stickyTasksMain,
      darkMode, darkPreset, lightPreset,
      eventColorStyle, sidebarStyle,
      dayStartH, dayEndH,
      ...deviceExtrasRef.current,
    });
  }, [calendarView, customDaysBefore, customDaysAfter, interval, tasksPanelOpen,
      tasksPanelWidth, showTaskRow, stickyAllDayMain, stickyTasksMain, darkMode,
      darkPreset, lightPreset, eventColorStyle, sidebarStyle, dayStartH, dayEndH]);

  // Apply dark mode CSS class whenever darkMode changes
  useEffect(() => {
    applyDarkModeClass(darkMode);
  }, [darkMode]);

  // Subscribe to live settings changes (e.g. from main page toggle)
  useEffect(() => {
    return subscribeSettingsChange(s => {
      // Remember what the shared file holds for the device-scoped keys so this
      // page can echo them back untouched — but do NOT adopt them; those come
      // from the device store above.
      for (const k of DEVICE_SCOPED_KEYS) {
        (sharedScopedRef.current as unknown as Record<string, unknown>)[k] =
          (s as unknown as Record<string, unknown>)[k];
      }
      setWidgetDarkPreset(s.widgetDarkPreset);
      setWidgetLightPreset(s.widgetLightPreset);
      setTimeFormat(s.timeFormat);
      setWeekStartsOn(s.weekStartsOn);
      setFocusDayStartHour(s.focusDayStartHour);
      setFocusChime(s.focusChime);
      setFocusCues(s.focusCues);
      setShortcuts(s.shortcuts);
      setAutoBackup(s.autoBackup);
      setTaskFilters(s.taskFilters);
      setTaskColor(s.taskColor);
      if (s.taskCheckboxShape) setTaskCheckboxShape(s.taskCheckboxShape);
      if (typeof s.googleSyncEnabled === 'boolean') setGoogleSyncEnabled(s.googleSyncEnabled);
      setGoogleTasksSync(s.googleTasksSync);
      if (typeof s.stickyAllDayWidget === 'boolean') setStickyAllDayWidget(s.stickyAllDayWidget);
      if (typeof s.stickyTasksWidget === 'boolean') setStickyTasksWidget(s.stickyTasksWidget);
      if (typeof s.gcalPushEnabled === 'boolean') setGcalPushEnabled(s.gcalPushEnabled);
      if (s.gcalPushTarget) setGcalPushTarget(s.gcalPushTarget);
      if (typeof s.gcalPushOtherCalendars === 'boolean') setGcalPushOtherCalendars(s.gcalPushOtherCalendars);
      if (typeof s.gcalPullDailyEdits === 'boolean') setGcalPullDailyEdits(s.gcalPullDailyEdits);
      if (typeof s.gcalPullDailyNew === 'boolean') setGcalPullDailyNew(s.gcalPullDailyNew);
      if (typeof s.gcalPullOtherCalendars === 'boolean') setGcalPullOtherCalendars(s.gcalPullOtherCalendars);
      if (typeof s.gcalMirrorLocalDeletions === 'boolean') setGcalMirrorLocalDeletions(s.gcalMirrorLocalDeletions);
      if (typeof s.gcalMirrorGoogleDeletions === 'boolean') setGcalMirrorGoogleDeletions(s.gcalMirrorGoogleDeletions);
      setPrayer(s.prayer);
      setHardware(s.hardware);
    });
  }, []);

  // Fetch backend settings to reconcile
  useEffect(() => {
    fetch('/api/settings')
      .then(r => r.json())
      .then((s) => {
        if (s && typeof s === 'object') {
          const coerced = coerceSettings(s);
          // Plan-wide only. The device-scoped keys in this file may have been
          // written by a different device, so they are recorded as the echo
          // baseline and otherwise ignored — this screen's copies live in the
          // device store.
          for (const k of DEVICE_SCOPED_KEYS) {
            (sharedScopedRef.current as unknown as Record<string, unknown>)[k] =
              (coerced as unknown as Record<string, unknown>)[k];
          }
          setWidgetDarkPreset(coerced.widgetDarkPreset);
          setWidgetLightPreset(coerced.widgetLightPreset);
          setTimeFormat(coerced.timeFormat);
          setWeekStartsOn(coerced.weekStartsOn);
          setFocusDayStartHour(coerced.focusDayStartHour);
          setFocusChime(coerced.focusChime);
          setFocusCues(coerced.focusCues);
          setShortcuts(coerced.shortcuts);
          setAutoBackup(coerced.autoBackup);
          setTaskFilters(coerced.taskFilters);
          setTaskColor(coerced.taskColor);
          setTaskCheckboxShape(coerced.taskCheckboxShape);
          setGoogleTasksSync(coerced.googleTasksSync);
          setStickyAllDayWidget(coerced.stickyAllDayWidget);
          setStickyTasksWidget(coerced.stickyTasksWidget);
          setPrayer(coerced.prayer);
          setHardware(coerced.hardware);
        }
      })
      .catch(err => console.error('Failed to load settings:', err));

    // Fetch Auto Backup Status
    fetch('/api/auto-backup')
      .then(r => r.json())
      .then(s => setBackupStatus({ count: Number(s.count) || 0, lastBackupAt: s.lastBackupAt ?? null }))
      .catch(() => {});

    // Fetch Google Auth Status
    fetch('/api/google-auth/status')
      .then(r => r.json())
      .then(status => {
        setGCalStatus(status);
        if (status.clientId) setClientIdInput(status.clientId);
        if (status.clientSecret) setClientSecretInput(status.clientSecret);
      })
      .catch(() => {});
  }, []);

  // Broadcast settings change live whenever local state changes.
  // Coalesced on a short trailing timer: a broadcast re-serialises every setting,
  // writes localStorage synchronously and POSTs, so a control that changes rapidly
  // (or several that change together) used to pay that cost once per change.
  useEffect(() => {
    if (!settingsLoaded.current) return;
    const broadcastId = window.setTimeout(() => broadcastSettingsChange({
      // Device-scoped keys (view, interval, theme, panel, day window) are echoed
      // back exactly as the shared file had them. They belong to THIS screen and
      // travel to the planner through the device channel below — putting them in
      // here would push the phone's dark mode onto the desktop.
      ...sharedScopedRef.current,
      widgetDarkPreset,
      widgetLightPreset,
      timeFormat,
      weekStartsOn,
      focusDayStartHour,
      focusChime,
      focusCues,
      shortcuts,
      autoBackup,
      taskFilters,
      taskColor,
      taskCheckboxShape,
      googleSyncEnabled,
      googleTasksSync,
      stickyAllDayWidget,
      stickyTasksWidget,
      gcalPushEnabled,
      gcalPushTarget,
      gcalPushOtherCalendars,
      gcalPullDailyEdits,
      gcalPullDailyNew,
      gcalPullOtherCalendars,
      gcalMirrorLocalDeletions,
      gcalMirrorGoogleDeletions,
      prayer,
      hardware,
    }), 150);
    return () => window.clearTimeout(broadcastId);
  }, [hardware, prayer, interval, darkMode, darkPreset, lightPreset, widgetDarkPreset, widgetLightPreset, calendarView, customDaysBefore, customDaysAfter, eventColorStyle, sidebarStyle, timeFormat, weekStartsOn, dayStartH, dayEndH, focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup, tasksPanelOpen, tasksPanelWidth, taskFilters, showTaskRow, taskColor,
      taskCheckboxShape, googleSyncEnabled, googleTasksSync, stickyAllDayMain, stickyTasksMain, stickyAllDayWidget, stickyTasksWidget, gcalPushEnabled, gcalPushTarget, gcalPushOtherCalendars, gcalPullDailyEdits, gcalPullDailyNew, gcalPullOtherCalendars, gcalMirrorLocalDeletions, gcalMirrorGoogleDeletions]);

  // Global keydown for Shortcut Recorder and Esc Navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (recordingAction) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          setRecordingAction(null);
          return;
        }
        const combo = eventToCombo(e);
        if (!combo) return;
        if (isReservedCombo(combo)) {
          showToast(`${formatCombo(combo)} is reserved by OS — pick another key.`, 'error');
          setRecordingAction(null);
          return;
        }
        setShortcuts(prev => ({ ...prev, [recordingAction]: combo }));
        setRecordingAction(null);
        showToast(`Bound shortcut for ${recordingAction} to ${formatCombo(combo)}`, 'success');
        return;
      }

      if (e.key === 'Escape') {
        setLocation('/');
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [recordingAction, setLocation, showToast]);

  // Actions
  const runBackupNow = useCallback(() => {
    fetch('/api/auto-backup', { method: 'POST' })
      .then(async res => {
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          showToast(body?.error || 'Backup failed.', 'error');
          return;
        }
        showToast(`Backup saved (${body.count} items).`, 'success');
        return fetch('/api/auto-backup')
          .then(r => r.json())
          .then(s => setBackupStatus({ count: Number(s.count) || 0, lastBackupAt: s.lastBackupAt ?? null }));
      })
      .catch(() => showToast("Couldn't reach server to back up.", 'error'));
  }, [showToast]);

  const currentSettingsSnapshot = (): AppSettings => ({
    interval,
    darkMode,
    darkPreset,
    lightPreset,
    widgetDarkPreset,
    widgetLightPreset,
    calendarView,
    customDaysBefore,
    customDaysAfter,
    eventColorStyle,
    sidebarStyle,
    timeFormat,
    weekStartsOn,
    dayStartH,
    dayEndH,
    focusDayStartHour,
    focusChime,
    focusCues,
    shortcuts,
    autoBackup,
    tasksPanelOpen,
    tasksPanelWidth,
    taskFilters,
    showTaskRow,
    taskColor,
    taskCheckboxShape,
    googleSyncEnabled,
    googleTasksSync,
    stickyAllDayMain,
    stickyTasksMain,
    stickyAllDayWidget,
    stickyTasksWidget,
    gcalPushEnabled,
    gcalPushTarget,
    gcalPushOtherCalendars,
    gcalPullDailyEdits,
    gcalPullDailyNew,
    gcalPullOtherCalendars,
    gcalMirrorLocalDeletions,
    gcalMirrorGoogleDeletions,
    prayer,
    hardware,
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
    setCalendarView(restored.calendarView);
    setCustomDaysBefore(restored.customDaysBefore);
    setCustomDaysAfter(restored.customDaysAfter);
    setEventColorStyle(restored.eventColorStyle);
    setSidebarStyle(restored.sidebarStyle);
    setTimeFormat(restored.timeFormat);
    setWeekStartsOn(restored.weekStartsOn);
    setDayStartH(restored.dayStartH);
    setDayEndH(restored.dayEndH);
    setFocusDayStartHour(restored.focusDayStartHour);
    setFocusChime(restored.focusChime);
    setFocusCues(restored.focusCues);
    setShortcuts(restored.shortcuts);
    setAutoBackup(restored.autoBackup);
    setTasksPanelOpen(restored.tasksPanelOpen);
    setTasksPanelWidth(restored.tasksPanelWidth);
    setTaskFilters(restored.taskFilters);
    setShowTaskRow(restored.showTaskRow);
    setTaskColor(restored.taskColor);
    if (restored.taskCheckboxShape) setTaskCheckboxShape(restored.taskCheckboxShape);
    setGoogleTasksSync(restored.googleTasksSync);
    setPrayer(restored.prayer);
    setHardware(restored.hardware);
    broadcastSettingsChange(restored);
  };

  const exportBackup = async () => {
    try {
      const [eventsRes, focusSessionsRes, tasksRes] = await Promise.all([
        fetch('/api/events'),
        fetch('/api/focus-sessions'),
        fetch('/api/tasks'),
      ]);
      if (!eventsRes.ok || !focusSessionsRes.ok) throw new Error('Failed to read backup sources');

      const events = await eventsRes.json();
      const focusSessions = await focusSessionsRes.json();
      const tasks = tasksRes.ok ? await tasksRes.json().catch(() => ({})) : {};
      const backupData = {
        // v3 adds `tasks`. Importers accept 2 (no tasks) and 3.
        backupFormatVersion: 3,
        exportedAt: new Date().toISOString(),
        events,
        settings: currentSettingsSnapshot(),
        focusSessions: Array.isArray(focusSessions) ? focusSessions : [],
        tasks: tasks && typeof tasks === 'object' && !Array.isArray(tasks) ? tasks : {},
      };

      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(backupData, null, 2));
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', `weekly-planner-backup-${new Date().toISOString().split('T')[0]}.json`);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      showToast('Backup JSON exported successfully!', 'success');
    } catch {
      showToast('Failed to export backup.', 'error');
    }
  };

  const importBackup = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const parsed = JSON.parse(evt.target?.result as string);
        if (!parsed || typeof parsed !== 'object') {
          showToast("File isn't a valid backup.", 'error');
          return;
        }
        const incomingEvents = parsed.events || (parsed.backupFormatVersion ? null : parsed);
        if (!incomingEvents) {
          showToast('No valid event data found in file.', 'error');
          return;
        }
        const sessions = Array.isArray(parsed.focusSessions) ? parsed.focusSessions : null;
        // Absent in v2 backups — leave existing tasks alone rather than wiping them.
        const tasks = parsed.tasks && typeof parsed.tasks === 'object' && !Array.isArray(parsed.tasks) ? parsed.tasks : null;
        const parts = [
          parsed.settings ? 'restore all settings' : '',
          sessions ? 'replace focus history' : '',
          tasks ? 'replace tasks' : '',
        ].filter(Boolean);
        if (confirm(`Import backup? This will replace events${parts.length ? `, ${parts.join(', ')}` : ''}.`)) {
          const eventsRes = await fetch('/api/events?force=1', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(incomingEvents),
          });
          if (!eventsRes.ok) throw new Error('Failed to import events');

          if (parsed.settings) {
            applyImportedSettings(parsed.settings, parsed.shortcuts);
          }

          if (sessions) {
            const sessionsRes = await fetch('/api/focus-sessions?force=1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(sessions),
            });
            if (!sessionsRes.ok) throw new Error('Failed to import focus sessions');
          }

          if (tasks) {
            const tasksRes = await fetch('/api/tasks?force=1', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(tasks),
            });
            if (!tasksRes.ok) throw new Error('Failed to import tasks');
          }

          showToast('Backup imported successfully!', 'success');
        }
      } catch {
        showToast("Couldn't parse backup file.", 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Syncs calendar AND tasks. Both engines take the current store, merge, and
  // write the result back themselves, so this page can hand them what's on disk
  // rather than holding its own copy.
  const triggerGCalSync = () => {
    setGCalSyncing(true);
    Promise.all([
      fetch('/api/events').then(r => r.json()).then(events =>
        fetch('/api/google-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ events, weekStartsOn }),
        }).then(r => r.json())),
      googleTasksSync && gCalStatus.hasTasksScope
        ? fetch('/api/tasks').then(r => r.json()).then(tasks =>
            fetch('/api/google-tasks-sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tasks, today: new Date().toISOString().slice(0, 10), weekStartsOn }),
            }).then(r => r.json()))
        : Promise.resolve({ success: true, tasks: {} }),
    ])
      .then(([cal, tsk]) => {
        if (!cal.success) { showToast(cal.error || 'Google sync failed.', 'error'); return; }
        const events = Object.keys(cal.events || {}).length;
        const taskCount = Object.keys(tsk.tasks || {}).length;
        showToast(`Google synced — ${events} event${events === 1 ? '' : 's'}, ${taskCount} task${taskCount === 1 ? '' : 's'}.`, 'success');
      })
      .catch(() => showToast('Failed to reach the sync server.', 'error'))
      .finally(() => setGCalSyncing(false));
  };

  // Painted from the same shared preset table as the planner windows, so this
  // page always matches whatever theme is selected on it.
  const activeTheme = themePalette(darkMode, darkPreset, lightPreset);
  const pageBg = activeTheme.rootBg;
  const cardBg = activeTheme.cardBg;
  // The sticky header sits over scrolling content, so it takes the card colour at
  // ~85% and lets the blur behind it do the rest.
  // Opaque on a phone. Both sticky bars sit over the scrolling settings body,
  // so a translucent one has to re-run its backdrop blur on every scroll frame —
  // the single most expensive thing on this page, and the reason scrolling it
  // felt like it was dropping frames on a mid-range phone.
  const headerBg = isPhone ? activeTheme.cardBg : `${activeTheme.cardBg}d9`;
  const cardBdr = activeTheme.surfaceBdr;
  const textPrimary = darkMode ? '#f1f5f9' : '#0f172a';
  const textSecondary = darkMode ? '#94a3b8' : '#64748b';
  const accentColor = '#3b82f6';
  const accentLight = darkMode ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.08)';

  const tabs: { id: TabCategory; label: string; icon: React.ReactNode; badge?: string }[] = [
    { id: 'appearance', label: 'Appearance', icon: <Sun size={17} /> },
    { id: 'calendar', label: 'Calendar Grid', icon: <Calendar size={17} /> },
    { id: 'prayer', label: 'Prayer Times', icon: <Compass size={17} /> },
    { id: 'audio', label: 'Focus & Audio', icon: <Volume2 size={17} /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={17} /> },
    { id: 'backup', label: 'Backups & Data', icon: <Database size={17} /> },
    { id: 'integrations', label: 'Integrations', icon: <Link2 size={17} />, badge: gCalStatus.authenticated ? 'Connected' : undefined },
    { id: 'hardware', label: 'Desk Controller', icon: <Cpu size={17} /> },
  ];

  return (
    <div
      className={`min-h-screen flex flex-col font-sans transition-colors duration-300 relative ${
        darkMode ? 'dark text-[#f1f5f9]' : 'text-[#0f172a]'
      }`}
      style={{ backgroundColor: pageBg }}
    >
      {/* ── Outer Side Ambient Glow Layer ── */}
      <div className="fixed inset-0 pointer-events-none z-0 overflow-hidden">
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
        <div
          className="absolute inset-0 opacity-[0.035] dark:opacity-[0.06] pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(${darkMode ? 'rgba(255,255,255,0.8)' : 'rgba(15,23,42,0.8)'} 1px, transparent 1px)`,
            backgroundSize: '28px 28px',
          }}
        />
      </div>
      {/* ── Top Header Navigation Bar ────────────────────────────────────────── */}
      <header
        className={`sticky top-0 z-50 flex items-center justify-between border-b transition-colors ${isPhone ? 'px-3 py-2.5' : 'backdrop-blur-md px-6 py-4'}`}
        style={{
          background: headerBg,
          borderColor: cardBdr,
          paddingTop: isPhone ? 'calc(10px + var(--safe-top))' : undefined,
        }}
      >
        <div className={`flex items-center min-w-0 ${isPhone ? 'gap-2' : 'gap-4'}`}>
          <button
            onClick={() => setLocation('/')}
            className={`flex items-center gap-2 rounded-xl text-xs font-semibold transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] flex-shrink-0 ${isPhone ? 'w-10 h-10 justify-center' : 'px-3.5 py-2'}`}
            style={{
              background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              border: `1px solid ${cardBdr}`,
              color: textPrimary,
            }}
            title="Back to Planner"
          >
            <ArrowLeft size={16} />
            {!isPhone && <span>Back to Planner</span>}
          </button>

          {!isPhone && <div className="h-5 w-[1px]" style={{ background: cardBdr }} />}

          <div className="flex items-center gap-2.5 min-w-0">
            {!isPhone && (
              <div
                className="p-2 rounded-xl flex items-center justify-center shadow-sm"
                style={{ background: accentLight, color: accentColor }}
              >
                <Sliders size={18} />
              </div>
            )}
            <div className="min-w-0">
              <h1 className={`font-bold tracking-tight truncate ${isPhone ? 'text-[15px]' : 'text-base'}`} style={{ color: textPrimary }}>
                {isPhone ? 'Settings' : 'Settings & Preferences'}
              </h1>
              {!isPhone && (
                <p className="text-[11px] font-medium" style={{ color: textSecondary }}>
                  Customize your workspace, layout, and shortcuts
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Header Right Controls */}
        <div className="flex items-center gap-3 flex-shrink-0">
          {/* Dark Mode Quick Toggle */}
          <button
            onClick={() => setDarkMode(d => !d)}
            className={`flex items-center gap-2 rounded-xl text-xs font-medium transition-all ${isPhone ? 'w-10 h-10 justify-center' : 'px-3 py-1.5'}`}
            style={{
              background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              border: `1px solid ${cardBdr}`,
              color: textPrimary,
            }}
            title="Toggle Dark / Light Mode"
          >
            {darkMode ? <Moon size={15} className="text-indigo-400" /> : <Sun size={15} className="text-amber-500" />}
            {!isPhone && <span className="capitalize">{darkMode ? 'Dark' : 'Light'}</span>}
          </button>

          {/* There is no Esc key on a phone — and no room for the hint either. */}
          {!isPhone && (
            <span className="text-[11px] font-mono px-2 py-1 rounded-md" style={{ background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', color: textSecondary }}>
              Esc to exit
            </span>
          )}
        </div>
      </header>

      {/* ── Main Layout Body ────────────────────────────────────────────────── */}
      <div className={`flex-1 max-w-7xl w-full mx-auto ${isPhone ? 'flex flex-col px-3 pt-3 pb-8 gap-4' : 'flex px-6 py-8 gap-8'}`}>
        {/* Category navigation. A vertical rail on a desktop; on a phone the
            same list turned on its side into a sticky, swipeable chip strip —
            no accordion, no hamburger, and the current section always visible. */}
        {isPhone ? (
          <div
            className="sticky z-40 -mx-3 px-3 py-2 flex gap-1.5 overflow-x-auto no-scrollbar touch-scroll"
            style={{ top: 'calc(56px + var(--safe-top))', background: headerBg }}
          >
            {tabs.map(tab => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center gap-1.5 px-3 h-9 rounded-xl text-[12px] font-bold whitespace-nowrap flex-shrink-0 active:scale-95 transition-transform"
                  style={{
                    background: active ? accentLight : (darkMode ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'),
                    color: active ? accentColor : textSecondary,
                    border: `1px solid ${active ? (darkMode ? 'rgba(59,130,246,0.35)' : 'rgba(59,130,246,0.25)') : cardBdr}`,
                  }}
                >
                  <span style={{ color: active ? accentColor : textSecondary, display: 'flex' }}>{tab.icon}</span>
                  {tab.label}
                  {tab.badge && (
                    <span className="text-[8.5px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <aside className="w-64 flex-shrink-0 flex flex-col gap-1.5">
            <span className="text-[10px] font-bold uppercase tracking-wider px-3 mb-1" style={{ color: textSecondary }}>
              Categories
            </span>

            {tabs.map(tab => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className="flex items-center justify-between px-3.5 py-3 rounded-2xl text-xs font-semibold transition-all duration-200 text-left"
                  style={{
                    background: active ? accentLight : 'transparent',
                    color: active ? accentColor : textSecondary,
                    border: active ? `1px solid ${darkMode ? 'rgba(59,130,246,0.3)' : 'rgba(59,130,246,0.2)'}` : '1px solid transparent',
                  }}
                >
                  <div className="flex items-center gap-3">
                    <span style={{ color: active ? accentColor : textSecondary }}>{tab.icon}</span>
                    <span>{tab.label}</span>
                  </div>
                  {tab.badge && (
                    <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/20">
                      {tab.badge}
                    </span>
                  )}
                </button>
              );
            })}
          </aside>
        )}

        {/* Content Container */}
        <main className={`flex-1 min-w-0 flex flex-col ${isPhone ? 'gap-4' : 'gap-6'}`}>
          <AnimatePresence mode="wait">
            {/* 🎨 APPEARANCE TAB */}
            {activeTab === 'appearance' && (
              <motion.div
                key="appearance"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Theme & Background
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Light or dark, and the base surface tone each window is painted in.
                    </p>
                  </div>

                  {/* Dark Mode Card */}
                  <div className="flex items-center justify-between p-4 rounded-2xl border gap-3" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="p-2.5 rounded-xl flex-shrink-0" style={{ background: darkMode ? 'rgba(129, 140, 248, 0.15)' : 'rgba(245, 158, 11, 0.15)', color: darkMode ? '#818cf8' : '#f59e0b' }}>
                        {darkMode ? <Moon size={20} /> : <Sun size={20} />}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Dark Mode</span>
                        <span className="text-[11px] block leading-snug" style={{ color: textSecondary }}>Sleek, high-contrast dark palette tailored for night focus</span>
                      </div>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={darkMode}
                      onClick={() => setDarkMode(d => !d)}
                      className="relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer"
                      style={{
                        background: darkMode ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'),
                      }}
                      title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
                    >
                      <span
                        className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 shadow-md"
                        style={{
                          transform: darkMode ? 'translateX(20px)' : 'translateX(0px)',
                        }}
                      />
                    </button>
                  </div>

                  {/* Main window background */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Main Window {darkMode ? 'Dark' : 'Light'} Background Color Style
                    </span>
                    <span className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                      The base surface tone of the main planner window. The side window has its own, set below.
                    </span>
                    <BackgroundPresetGrid
                      dark={darkMode}
                      value={darkMode ? darkPreset : lightPreset}
                      onChange={id => darkMode ? setDarkPreset(id as DarkPreset) : setLightPreset(id as LightPreset)}
                      cardBdr={cardBdr}
                    />
                  </div>

                  {/* Side window background — its own choice, deliberately separate. */}
                  <div className="flex flex-col gap-3 pt-5 border-t" style={{ borderColor: cardBdr }}>
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Side Window {darkMode ? 'Dark' : 'Light'} Background Color Style
                    </span>
                    <span className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                      The small always-on-top window has its own background tone. Every other appearance
                      setting below is shared with the main window.
                    </span>
                    <BackgroundPresetGrid
                      dark={darkMode}
                      value={darkMode ? widgetDarkPreset : widgetLightPreset}
                      onChange={id => darkMode ? setWidgetDarkPreset(id as DarkPreset) : setWidgetLightPreset(id as LightPreset)}
                      cardBdr={cardBdr}
                    />
                  </div>
                </div>

                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Cards & Canvas
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      How events and the surrounding canvas are drawn. Shared by both windows.
                    </p>
                  </div>

                  {/* Universal Event Card Style Picker */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Event Card Style (Applies to All Items & Google Calendar)
                    </span>
                    <span className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                      Unified card layout and border styling for every item on your planner.
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { id: 'tinted', label: 'Glass & Border Accent', desc: 'Soft translucent fill with a vivid border stroke (Default)' },
                        { id: 'solid', label: 'Solid Smooth Fill', desc: 'Bold, sleek solid color fill with high-contrast text' },
                        { id: 'minimal', label: 'Minimal Left Accent', desc: 'Clean surface card with a vivid left vertical accent strip' },
                        { id: 'glowing', label: 'Luminous Neon Glow', desc: 'Glowing neon border stroke with soft ambient backlight shadow' },
                      ].map(style => {
                        const selected = eventColorStyle === style.id;
                        return (
                          <button
                            key={style.id}
                            onClick={() => setEventColorStyle(style.id as any)}
                            className="p-3.5 rounded-2xl border text-left flex flex-col gap-1.5 transition-all cursor-pointer hover:scale-[1.01]"
                            style={{
                              background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                              borderColor: selected ? accentColor : cardBdr,
                              boxShadow: selected ? `0 0 0 2px ${accentLight}` : 'none',
                            }}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold" style={{ color: textPrimary }}>{style.label}</span>
                              {selected && <Check size={14} style={{ color: accentColor }} />}
                            </div>
                            <span className="text-[10px] leading-snug" style={{ color: textSecondary }}>{style.desc}</span>
                          </button>
                        );
                      })}
                      </div>
                    </div>

                  {/* Canvas Ambient Background Aura Style Picker */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Canvas Ambient Background Style
                    </span>
                    <span className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                      Controls ambient side glow effects and background aura styling across all pages.
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { id: 'subtle-glow', label: 'Subtle Ambient Glow', desc: 'Soft side aura glow smoothly fading into canvas (Default)' },
                        { id: 'accent-aura', label: 'Vivid Luminous Aura', desc: 'Richer, vibrant indigo & emerald side gradients' },
                        { id: 'minimal-flat', label: 'Minimal Flat Canvas', desc: 'Clean, flat border-aligned surface without ambient side glow' },
                        { id: 'glass-translucent', label: 'Frosted Glass Surface', desc: 'Translucent frosted glass panels with subtle backdrop blur' },
                      ].map(style => {
                        const selected = sidebarStyle === style.id;
                        return (
                          <button
                            key={style.id}
                            onClick={() => setSidebarStyle(style.id as any)}
                            className="p-3.5 rounded-2xl border text-left flex flex-col gap-1.5 transition-all cursor-pointer hover:scale-[1.01]"
                            style={{
                              background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                              borderColor: selected ? accentColor : cardBdr,
                              boxShadow: selected ? `0 0 0 2px ${accentLight}` : 'none',
                            }}
                          >
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-bold" style={{ color: textPrimary }}>{style.label}</span>
                              {selected && <Check size={14} style={{ color: accentColor }} />}
                            </div>
                            <span className="text-[10px] leading-snug" style={{ color: textSecondary }}>{style.desc}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                </div>

                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Display
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      How times are written throughout the planner.
                    </p>
                  </div>

                  {/* Time Format */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Time Display Format
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {(['12h', '24h'] as TimeFormat[]).map(fmt => {
                        const selected = timeFormat === fmt;
                        return (
                          <button
                            key={fmt}
                            onClick={() => setTimeFormat(fmt)}
                            className="flex items-center justify-between p-4 rounded-2xl border text-left transition-all"
                            style={{
                              background: selected ? accentLight : 'transparent',
                              borderColor: selected ? accentColor : cardBdr,
                            }}
                          >
                            <div>
                              <span className="text-xs font-bold block" style={{ color: selected ? accentColor : textPrimary }}>
                                {fmt === '12h' ? '12-Hour (AM/PM)' : '24-Hour (Military)'}
                              </span>
                              <span className="text-[11px] block mt-0.5" style={{ color: textSecondary }}>
                                {fmt === '12h' ? 'e.g. 9:00 AM, 2:30 PM' : 'e.g. 09:00, 14:30'}
                              </span>
                            </div>
                            {selected && <CheckCircle2 size={18} style={{ color: accentColor }} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* 📅 CALENDAR TAB */}
            {activeTab === 'calendar' && (
              <motion.div
                key="calendar"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Calendar & Grid View
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Configure week start days, time slot resolution, and visible daytime hours.
                    </p>
                  </div>

                  {/* Week Starts On */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>First Day of the Week</span>
                    <div className="grid grid-cols-7 gap-2">
                      {[
                        [0, 'Sun'],
                        [1, 'Mon'],
                        [2, 'Tue'],
                        [3, 'Wed'],
                        [4, 'Thu'],
                        [5, 'Fri'],
                        [6, 'Sat'],
                      ].map(([dayVal, label]) => {
                        const active = weekStartsOn === dayVal;
                        return (
                          <button
                            key={dayVal}
                            onClick={() => setWeekStartsOn(dayVal as WeekStartsOn)}
                            className="py-3 rounded-xl text-xs font-semibold transition-all text-center"
                            style={{
                              background: active ? accentColor : (darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)'),
                              color: active ? '#ffffff' : textPrimary,
                              border: `1px solid ${active ? accentColor : cardBdr}`,
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Grid Interval */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>Time Slot Snap Interval</span>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      {([5, 15, 30, 60] as IntervalMin[]).map(v => {
                        const active = interval === v;
                        return (
                          <button
                            key={v}
                            onClick={() => setIntervalOpt(v)}
                            className="p-3.5 rounded-2xl border text-center transition-all"
                            style={{
                              background: active ? accentLight : 'transparent',
                              borderColor: active ? accentColor : cardBdr,
                            }}
                          >
                            <span className="text-xs font-bold block" style={{ color: active ? accentColor : textPrimary }}>
                              {v} Minutes
                            </span>
                            <span className="text-[10px] block mt-0.5" style={{ color: textSecondary }}>
                              {v === 5 ? 'Ultra granular' : v === 15 ? 'Standard' : v === 30 ? 'Broad blocks' : 'Hourly'}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Visible Hours */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>Visible Schedule Hours</span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 rounded-2xl border" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[11px] font-medium" style={{ color: textSecondary }}>Start Hour</label>
                        <select
                          value={dayStartH}
                          onChange={e => {
                            const newStart = parseInt(e.target.value);
                            const duration = dayEndH - dayStartH;
                            setDayStartH(newStart);
                            setDayEndH(newStart + duration);
                          }}
                          className="w-full py-2 px-3 text-xs font-semibold rounded-xl border outline-none transition-colors"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        >
                          {Array.from({ length: 24 }, (_, i) => i).map(h => (
                            <option key={h} value={h}>{h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-[11px] font-medium" style={{ color: textSecondary }}>Span Duration</label>
                        <select
                          value={dayEndH - dayStartH}
                          onChange={e => setDayEndH(dayStartH + parseInt(e.target.value))}
                          className="w-full py-2 px-3 text-xs font-semibold rounded-xl border outline-none transition-colors"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        >
                          {Array.from({ length: 24 }, (_, i) => i + 1).map(d => (
                            <option key={d} value={d}>{d} {d === 1 ? 'Hour' : 'Hours'}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Sticky Header Bands (Scroll View) */}
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Sticky Bands on Scroll
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Keep All-Day events and Tasks fixed at the top when scrolling down the timeline grid. Configurable independently for each view.
                    </p>
                  </div>

                  <div className="flex flex-col gap-4">
                    <span className="text-xs font-bold uppercase tracking-wider text-primary/80">Main Window</span>
                    
                    <label className="flex items-center justify-between gap-4 cursor-pointer">
                      <span className="flex flex-col">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Sticky All-Day Events</span>
                        <span className="text-[11px]" style={{ color: textSecondary }}>
                          Keep the All-Day section pinned at the top when scrolling down the main calendar grid.
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setStickyAllDayMain(v => !v)}
                        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyAllDayMain ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyAllDayMain}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
                          style={{ left: stickyAllDayMain ? 22 : 2 }}
                        />
                      </button>
                    </label>

                    <label className="flex items-center justify-between gap-4 cursor-pointer">
                      <span className="flex flex-col">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Sticky Tasks</span>
                        <span className="text-[11px]" style={{ color: textSecondary }}>
                          Keep the Tasks row pinned at the top when scrolling down the main calendar grid.
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setStickyTasksMain(v => !v)}
                        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyTasksMain ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyTasksMain}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
                          style={{ left: stickyTasksMain ? 22 : 2 }}
                        />
                      </button>
                    </label>
                  </div>

                  <div className="border-t pt-4 flex flex-col gap-4" style={{ borderColor: cardBdr }}>
                    <span className="text-xs font-bold uppercase tracking-wider text-primary/80">Sidebar Widget Window</span>

                    <label className="flex items-center justify-between gap-4 cursor-pointer">
                      <span className="flex flex-col">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Sticky All-Day Events</span>
                        <span className="text-[11px]" style={{ color: textSecondary }}>
                          Keep All-Day events pinned at the top of the sidebar widget timeline when scrolling.
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setStickyAllDayWidget(v => !v)}
                        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyAllDayWidget ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyAllDayWidget}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
                          style={{ left: stickyAllDayWidget ? 22 : 2 }}
                        />
                      </button>
                    </label>

                    <label className="flex items-center justify-between gap-4 cursor-pointer">
                      <span className="flex flex-col">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Sticky Tasks</span>
                        <span className="text-[11px]" style={{ color: textSecondary }}>
                          Keep Tasks pinned at the top of the sidebar widget timeline when scrolling.
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setStickyTasksWidget(v => !v)}
                        className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyTasksWidget ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyTasksWidget}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
                          style={{ left: stickyTasksWidget ? 22 : 2 }}
                        />
                      </button>
                    </label>
                  </div>
                </div>

                {/* Tasks */}
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Tasks</h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      How tasks appear on the weekly grid. Tasks that live only in the side panel have no colour unless you give them one.
                    </p>
                  </div>

                  <label className="flex items-center justify-between gap-4 cursor-pointer">
                    <span className="flex flex-col">
                      <span className="text-xs font-semibold" style={{ color: textPrimary }}>Show the task row</span>
                      <span className="text-[11px]" style={{ color: textSecondary }}>
                        A band directly under All Day holding tasks that have a date but no time.
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowTaskRow(v => !v)}
                      className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                      style={{ background: showTaskRow ? taskColor : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={showTaskRow}
                    >
                      <span
                        className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all"
                        style={{ left: showTaskRow ? 22 : 2 }}
                      />
                    </button>
                  </label>

                  <div className="flex items-center justify-between gap-4">
                    <span className="flex flex-col">
                      <span className="text-xs font-semibold" style={{ color: textPrimary }}>Task Checkbox Shape</span>
                      <span className="text-[11px]" style={{ color: textSecondary }}>
                        Choose whether completed task checkboxes are circles or squares in the side panel.
                      </span>
                    </span>
                    <div className="flex items-center gap-1.5 p-1 rounded-xl border" style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', borderColor: cardBdr }}>
                      <button
                        type="button"
                        onClick={() => setTaskCheckboxShape('circle')}
                        className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold transition-all"
                        style={{
                          background: taskCheckboxShape === 'circle' ? taskColor : 'transparent',
                          color: taskCheckboxShape === 'circle' ? (darkMode ? '#0b1220' : '#ffffff') : textSecondary,
                        }}
                      >
                        <span className="w-2.5 h-2.5 rounded-full border border-current" /> Circle
                      </button>
                      <button
                        type="button"
                        onClick={() => setTaskCheckboxShape('square')}
                        className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold transition-all"
                        style={{
                          background: taskCheckboxShape === 'square' ? taskColor : 'transparent',
                          color: taskCheckboxShape === 'square' ? (darkMode ? '#0b1220' : '#ffffff') : textSecondary,
                        }}
                      >
                        <span className="w-2.5 h-2.5 rounded-sm border border-current" /> Square
                      </button>
                    </div>
                  </div>

                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>Task colour on the calendar</span>
                    <p className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                      Every task drawn on the grid uses this one colour — that uniformity is what makes a task read as a task at a glance.
                    </p>
                    <div className="flex items-center gap-2 flex-wrap">
                      {['#7dd3fc', '#67e8f9', '#a5b4fc', '#c4b5fd', '#86efac', '#fcd34d', '#fda4af', '#94a3b8'].map(hex => (
                        <button
                          key={hex}
                          onClick={() => setTaskColor(hex)}
                          className="w-8 h-8 rounded-lg transition-transform hover:scale-110"
                          style={{
                            background: hex,
                            border: `2px solid ${taskColor.toLowerCase() === hex ? textPrimary : 'transparent'}`,
                          }}
                          title={hex}
                        />
                      ))}
                      <label
                        className="flex items-center gap-2 px-3 py-1.5 rounded-xl border cursor-pointer"
                        style={{ borderColor: cardBdr, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)' }}
                      >
                        <span className="text-[11px] font-semibold" style={{ color: textSecondary }}>Custom</span>
                        <input
                          type="color"
                          value={taskColor}
                          onChange={e => setTaskColor(e.target.value)}
                          className="w-6 h-6 bg-transparent border-0 cursor-pointer p-0"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* 🕌 PRAYER TIMES TAB */}
            {activeTab === 'prayer' && (
              <motion.div
                key="prayer"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Prayer Times</h2>
                      <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                        Fetched from the Aladhan API for your city and kept up to date daily. A prayer has a start
                        time and no duration, so it never takes up space on the grid — tick it off like a task.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => patchPrayer({ enabled: !prayer.enabled })}
                      className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                      style={{ background: prayer.enabled ? prayer.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={prayer.enabled}
                      title={prayer.enabled ? 'Prayer times are shown' : 'Prayer times are hidden'}
                    >
                      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: prayer.enabled ? 22 : 2 }} />
                    </button>
                  </div>

                  {prayer.enabled && (
                    <>
                      <PrayerTodayPreview prayer={prayer} textPrimary={textPrimary} textSecondary={textSecondary} cardBdr={cardBdr} darkMode={darkMode} />

                      {/* Location */}
                      <div className="flex flex-col gap-3">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Location</span>
                        <p className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                          City and country are geocoded by the API. Spelling matters — "Amman" / "Jordan".
                        </p>
                        <div className="flex items-center gap-2">
                          <input
                            defaultValue={prayer.city}
                            key={`city-${prayer.city}`}
                            onBlur={e => { const v = e.target.value.trim(); if (v && v !== prayer.city) patchPrayer({ city: v }); }}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            placeholder="City"
                            className="flex-1 px-3 py-2 rounded-xl border text-xs outline-none"
                            style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          />
                          <input
                            defaultValue={prayer.country}
                            key={`country-${prayer.country}`}
                            onBlur={e => { const v = e.target.value.trim(); if (v && v !== prayer.country) patchPrayer({ country: v }); }}
                            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                            placeholder="Country"
                            className="flex-1 px-3 py-2 rounded-xl border text-xs outline-none"
                            style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          />
                        </div>
                      </div>

                      {/* Calculation method */}
                      <div className="flex flex-col gap-2">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Calculation method</span>
                        <p className="text-[11px] -mt-1" style={{ color: textSecondary }}>
                          The authority whose angles are used. This is the biggest single factor in matching your
                          local mosque — the same city can differ by ~20 minutes between methods.
                        </p>
                        <select
                          value={prayer.method}
                          onChange={e => patchPrayer({ method: Number(e.target.value) })}
                          className="px-3 py-2 rounded-xl border text-xs outline-none"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        >
                          {PRAYER_METHODS.map(m => (
                            <option key={m.id} value={m.id}>{m.label}</option>
                          ))}
                        </select>
                      </div>

                      {/* Asr madhab */}
                      <div className="flex items-center justify-between gap-4">
                        <span className="flex flex-col">
                          <span className="text-xs font-semibold" style={{ color: textPrimary }}>Asr madhab</span>
                          <span className="text-[11px]" style={{ color: textSecondary }}>
                            Hanafi puts Asr roughly 30–60 minutes later than the standard shadow ratio.
                          </span>
                        </span>
                        <div className="flex items-center gap-1.5 p-1 rounded-xl border flex-shrink-0" style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', borderColor: cardBdr }}>
                          {([[0, 'Standard'], [1, 'Hanafi']] as const).map(([val, label]) => (
                            <button
                              key={label}
                              type="button"
                              onClick={() => patchPrayer({ school: val })}
                              className="px-3 py-1 rounded-lg text-xs font-semibold transition-all"
                              style={{
                                background: prayer.school === val ? prayer.color : 'transparent',
                                color: prayer.school === val ? (darkMode ? '#0b1220' : '#ffffff') : textSecondary,
                              }}
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Which ones show */}
                      <div className="flex flex-col gap-3">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Which ones to show</span>
                        <p className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                          Sunrise isn't a prayer — it's off unless you switch it on here.
                        </p>
                        <div className="flex items-center gap-2 flex-wrap">
                          {PRAYER_KEYS.map(k => {
                            const on = k === 'sunrise' ? prayer.showSunrise : !prayer.hidden.includes(k);
                            return (
                              <button
                                key={k}
                                type="button"
                                onClick={() => {
                                  if (k === 'sunrise') { patchPrayer({ showSunrise: !prayer.showSunrise }); return; }
                                  patchPrayer({
                                    hidden: prayer.hidden.includes(k)
                                      ? prayer.hidden.filter(h => h !== k)
                                      : [...prayer.hidden, k],
                                  });
                                }}
                                className="px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all"
                                style={{
                                  background: on ? prayer.color : 'transparent',
                                  borderColor: on ? prayer.color : cardBdr,
                                  color: on ? (darkMode ? '#0b1220' : '#ffffff') : textSecondary,
                                }}
                              >
                                {PRAYER_LABELS[k]}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Display style */}
                      <div className="flex flex-col gap-3">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>How they're drawn</span>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {([
                            ['marker', 'Marker line', 'A hairline at the exact time. Never collides with events.'],
                            ['pill', 'Small pill', 'A compact chip on the timeline. More visible, can overlap.'],
                            ['row', 'Its own row', 'A strip above the grid, out of the timeline entirely.'],
                          ] as Array<[PrayerStyle, string, string]>).map(([id, label, desc]) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => patchPrayer({ style: id })}
                              className="p-3 rounded-2xl border text-left flex flex-col gap-1 transition-all"
                              style={{
                                background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)',
                                borderColor: prayer.style === id ? prayer.color : cardBdr,
                                boxShadow: prayer.style === id ? `0 0 0 2px ${prayer.color}55` : 'none',
                              }}
                            >
                              <span className="text-xs font-bold" style={{ color: textPrimary }}>{label}</span>
                              <span className="text-[10px] leading-snug" style={{ color: textSecondary }}>{desc}</span>
                            </button>
                          ))}
                        </div>
                      </div>

                      {/* Colour */}
                      <div className="flex flex-col gap-3">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Colour</span>
                        <div className="flex items-center gap-2 flex-wrap">
                          {['#34d399', '#4ade80', '#22d3ee', '#a78bfa', '#f59e0b', '#f472b6', '#e2e8f0', '#94a3b8'].map(hex => (
                            <button
                              key={hex}
                              onClick={() => patchPrayer({ color: hex })}
                              className="w-8 h-8 rounded-lg transition-transform hover:scale-110"
                              style={{ background: hex, border: `2px solid ${prayer.color.toLowerCase() === hex ? textPrimary : 'transparent'}` }}
                              title={hex}
                            />
                          ))}
                          <label className="flex items-center gap-2 px-3 py-1.5 rounded-xl border cursor-pointer" style={{ borderColor: cardBdr, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)' }}>
                            <span className="text-[11px] font-semibold" style={{ color: textSecondary }}>Custom</span>
                            <input
                              type="color"
                              value={prayer.color}
                              onChange={e => patchPrayer({ color: e.target.value })}
                              className="w-6 h-6 bg-transparent border-0 cursor-pointer p-0"
                            />
                          </label>
                        </div>
                      </div>

                      {/* Horizon */}
                      <div className="flex items-center justify-between gap-4">
                        <span className="flex flex-col">
                          <span className="text-xs font-semibold" style={{ color: textPrimary }}>Show up to</span>
                          <span className="text-[11px]" style={{ color: textSecondary }}>
                            How far ahead prayers are drawn. Past days always keep theirs.
                          </span>
                        </span>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <NumberField
                            min={PRAYER_HORIZON_MIN}
                            max={PRAYER_HORIZON_MAX}
                            value={prayer.horizonDays}
                            onCommit={n => patchPrayer({ horizonDays: n })}
                            ariaLabel="Days ahead"
                            className="w-20 px-3 py-2 rounded-xl border text-xs outline-none tabular-nums"
                            style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          />
                          <span className="text-xs" style={{ color: textSecondary }}>days ahead</span>
                        </div>
                      </div>

                      {/* Side window */}
                      <label className="flex items-center justify-between gap-4 cursor-pointer">
                        <span className="flex flex-col">
                          <span className="text-xs font-semibold" style={{ color: textPrimary }}>Show in the side window</span>
                          <span className="text-[11px]" style={{ color: textSecondary }}>
                            Prayers appear on the widget's timeline and in its day list.
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => patchPrayer({ showInWidget: !prayer.showInWidget })}
                          className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                          style={{ background: prayer.showInWidget ? prayer.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                          aria-pressed={prayer.showInWidget}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: prayer.showInWidget ? 22 : 2 }} />
                        </button>
                      </label>

                      {/* Manual corrections */}
                      <div className="flex flex-col gap-3">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Manual correction (minutes)</span>
                        <p className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                          Only if your mosque differs from the calculated time. Applied on top of the API result, ±60 max.
                        </p>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {PRAYER_KEYS.map(k => (
                            <label key={k} className="flex items-center justify-between gap-2 px-3 py-2 rounded-xl border" style={{ borderColor: cardBdr, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)' }}>
                              <span className="text-[11px] font-semibold" style={{ color: textSecondary }}>{PRAYER_LABELS[k]}</span>
                              <NumberField
                                min={-60}
                                max={60}
                                value={prayer.offsets[k] ?? 0}
                                onCommit={n => {
                                  const next: Partial<Record<PrayerKey, number>> = { ...prayer.offsets };
                                  if (n === 0) delete next[k];
                                  else next[k] = n;
                                  patchPrayer({ offsets: next });
                                }}
                                ariaLabel={`${PRAYER_LABELS[k]} correction in minutes`}
                                showErrorText={false}
                                className="w-14 bg-transparent text-xs text-right outline-none tabular-nums"
                                style={{ color: textPrimary }}
                              />
                            </label>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            )}

            {/* ⏱️ AUDIO TAB */}
            {activeTab === 'audio' && (
              <motion.div
                key="audio"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Focus Audio & Chimes
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Preview and select soothing WebAudio synthesizers for timer events.
                    </p>
                  </div>

                  {/* Chime picker */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>Session-Complete Sound Chime</span>
                    <div className="flex flex-col gap-2.5">
                      {FOCUS_CHIMES.map(c => {
                        const active = focusChime === c.id;
                        return (
                          <div
                            key={c.id}
                            className="flex items-center justify-between p-3.5 rounded-2xl border transition-all"
                            style={{
                              background: active ? accentLight : 'transparent',
                              borderColor: active ? accentColor : cardBdr,
                            }}
                          >
                            <div className="flex items-center gap-3">
                              <button
                                onClick={() => playFocusChime(c.id)}
                                className="p-2.5 rounded-xl border transition-all hover:scale-105"
                                style={{ background: cardBg, borderColor: cardBdr, color: accentColor }}
                                title="Click to preview chime"
                              >
                                <Volume2 size={16} />
                              </button>
                              <div>
                                <span className="text-xs font-bold block" style={{ color: active ? accentColor : textPrimary }}>
                                  {c.label}
                                </span>
                                <span className="text-[11px] block mt-0.5" style={{ color: textSecondary }}>
                                  {c.hint}
                                </span>
                              </div>
                            </div>

                            <button
                              onClick={() => {
                                setFocusChime(c.id);
                                playFocusChime(c.id);
                              }}
                              className="px-4 py-2 rounded-xl text-xs font-semibold transition-all"
                              style={{
                                background: active ? accentColor : (darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'),
                                color: active ? '#ffffff' : textPrimary,
                              }}
                            >
                              {active ? 'Selected' : 'Select'}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Timer Cues */}
                  <div className="flex flex-col gap-3 pt-4 border-t" style={{ borderColor: cardBdr }}>
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>Timer Cues</span>
                    {([
                      { slot: 'start' as FocusCueSlot, label: 'When the timer starts' },
                      { slot: 'pause' as FocusCueSlot, label: 'When paused or stopped' },
                      { slot: 'resume' as FocusCueSlot, label: 'When timer resumes' },
                    ]).map(({ slot, label }) => (
                      <div key={slot} className="flex flex-col gap-2 p-3.5 rounded-2xl border" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                        <span className="text-xs font-medium" style={{ color: textPrimary }}>{label}</span>
                        <div className="flex flex-wrap gap-2">
                          {FOCUS_CUES.map(c => {
                            const active = focusCues[slot] === c.id;
                            return (
                              <button
                                key={c.id}
                                onClick={() => {
                                  setFocusCues(prev => ({ ...prev, [slot]: c.id }));
                                  playFocusCue(c.id);
                                }}
                                className="px-3 py-1.5 rounded-xl text-xs font-semibold transition-all"
                                style={{
                                  background: active ? accentColor : cardBg,
                                  border: `1px solid ${active ? accentColor : cardBdr}`,
                                  color: active ? '#ffffff' : textSecondary,
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
                </div>
              </motion.div>
            )}

            {/* ⌨️ SHORTCUTS TAB */}
            {activeTab === 'shortcuts' && (
              <motion.div
                key="shortcuts"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className="flex items-center justify-between">
                    <div>
                      <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                        Keyboard Shortcuts
                      </h2>
                      <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                        Click any shortcut box, then press your desired key combination to rebind it.
                      </p>
                    </div>

                    <button
                      onClick={() => setShortcuts({ ...DEFAULT_SHORTCUTS })}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-all"
                      style={{ background: cardBg, borderColor: cardBdr, color: textSecondary }}
                    >
                      <RotateCcw size={14} />
                      <span>Reset Defaults</span>
                    </button>
                  </div>

                  {(['Navigation', 'View', 'Editing', 'Focus'] as const).map(group => (
                    <div key={group} className="flex flex-col gap-3">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-blue-500">
                        {group} Shortcuts
                      </span>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {SHORTCUT_DEFS.filter(d => d.group === group).map(def => {
                          const recording = recordingAction === def.action;
                          const conflicts = findConflicts(shortcuts, def.action);
                          return (
                            <button
                              key={def.action}
                              onClick={e => {
                                if (e.detail === 0) return;
                                setRecordingAction(recording ? null : def.action);
                              }}
                              className="flex items-center justify-between p-3.5 rounded-2xl border text-left transition-all"
                              style={{
                                background: recording ? accentLight : cardBg,
                                borderColor: recording ? accentColor : cardBdr,
                              }}
                            >
                              <div>
                                <span className="text-xs font-semibold block" style={{ color: textPrimary }}>
                                  {def.label}
                                </span>
                                <span className="text-[10px] block mt-0.5" style={{ color: textSecondary }}>
                                  {def.hint}
                                </span>
                              </div>

                              <kbd
                                className="text-xs font-mono font-semibold px-2.5 py-1 rounded-xl shadow-xs whitespace-nowrap"
                                style={{
                                  background: recording ? accentColor : (darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'),
                                  color: recording ? '#ffffff' : conflicts.length ? '#f87171' : textPrimary,
                                  border: `1px solid ${conflicts.length ? '#f87171' : cardBdr}`,
                                }}
                              >
                                {recording ? 'Press keys...' : formatCombo(shortcuts[def.action])}
                              </kbd>
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.div>
            )}

            {/* 💾 BACKUP TAB */}
            {activeTab === 'backup' && (
              <motion.div
                key="backup"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Data & Backup Management
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Automate backups or export JSON snapshots of your entire weekly plan and settings.
                    </p>
                  </div>

                  {/* Auto backup */}
                  <div className="p-4 rounded-2xl border flex flex-col gap-4" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-bold block" style={{ color: textPrimary }}>Automatic Local Backups</span>
                        <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Automatically save snapshots into your local project directory</span>
                      </div>

                      <button
                        type="button"
                        role="switch"
                        aria-checked={autoBackup.enabled}
                        onClick={() => setAutoBackup(c => ({ ...c, enabled: !c.enabled }))}
                        className="relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer"
                        style={{ background: autoBackup.enabled ? '#10b981' : (darkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)') }}
                      >
                        <span
                          className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white transition-transform duration-200 shadow-md"
                          style={{ transform: autoBackup.enabled ? 'translateX(20px)' : 'translateX(0px)' }}
                        />
                      </button>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t" style={{ borderColor: cardBdr }}>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[11px] font-medium" style={{ color: textSecondary }}>Backup Interval</label>
                        <select
                          value={autoBackup.intervalHours}
                          onChange={e => setAutoBackup(c => ({ ...c, intervalHours: parseInt(e.target.value) }))}
                          disabled={!autoBackup.enabled}
                          className="w-full py-2 px-3 text-xs font-semibold rounded-xl border outline-none"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary, opacity: autoBackup.enabled ? 1 : 0.4 }}
                        >
                          {[[1, 'Every Hour'], [3, 'Every 3 Hours'], [6, 'Every 6 Hours'], [12, 'Every 12 Hours'], [24, 'Daily'], [168, 'Weekly']].map(([h, label]) => (
                            <option key={h as number} value={h as number}>{label as string}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-[11px] font-medium" style={{ color: textSecondary }}>Snapshots Retained</label>
                        <NumberField
                          min={1}
                          max={500}
                          value={autoBackup.keep}
                          onCommit={n => setAutoBackup(c => ({ ...c, keep: n }))}
                          disabled={!autoBackup.enabled}
                          ariaLabel="Snapshots retained"
                          wrapStyle={{ width: '100%' }}
                          className="w-full py-2 px-3 text-xs font-semibold rounded-xl border outline-none"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary, opacity: autoBackup.enabled ? 1 : 0.4 }}
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-2">
                      <span className="text-[11px]" style={{ color: textSecondary }}>
                        {backupStatus ? `${backupStatus.count} backups stored in /backups folder` : 'No backup status'}
                      </span>
                      <button
                        onClick={runBackupNow}
                        className="px-4 py-2 rounded-xl text-xs font-semibold transition-all hover:scale-105"
                        style={{ background: accentColor, color: '#ffffff' }}
                      >
                        Back Up Now
                      </button>
                    </div>
                  </div>

                  {/* Manual Export & Import */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                    <button
                      onClick={exportBackup}
                      className="flex items-center justify-center gap-2.5 p-4 rounded-2xl border text-xs font-bold transition-all hover:scale-[1.01]"
                      style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                    >
                      <Download size={17} className="text-blue-500" />
                      <span>Export Backup (.json)</span>
                    </button>

                    <label
                      className="flex items-center justify-center gap-2.5 p-4 rounded-2xl border text-xs font-bold transition-all cursor-pointer hover:scale-[1.01]"
                      style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                    >
                      <Upload size={17} className="text-emerald-500" />
                      <span>Import Backup (.json)</span>
                      <input type="file" accept=".json" onChange={importBackup} className="hidden" />
                    </label>
                  </div>
                </div>
              </motion.div>
            )}

            {/* 🖥️ DESK CONTROLLER TAB */}
            {activeTab === 'hardware' && (
              <motion.div
                key="hardware"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Desk Controller</h2>
                      <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                        An ESP32 on the desk with an LCD, two buttons and an ultrasonic presence sensor. It drives the
                        focus timer through the same actions as the on-screen controls, so nothing here can make the
                        hardware and the app disagree.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => patchHardware({ enabled: !hardware.enabled })}
                      className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                      style={{ background: hardware.enabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={hardware.enabled}
                      title={hardware.enabled ? 'The desk controller is active' : 'The desk controller is ignored'}
                    >
                      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: hardware.enabled ? 22 : 2 }} />
                    </button>
                  </div>

                  {hardware.enabled && (
                    <>
                      {/* Buttons */}
                      <div className="flex items-start justify-between gap-4 pt-1">
                        <div className="flex-1">
                          <span className="text-xs font-semibold" style={{ color: textPrimary }}>Physical buttons</span>
                          <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                            Button A starts, pauses and resumes. Button B terminates the session — exactly as if you
                            had clicked the matching control in the app.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => patchHardware({ buttonsEnabled: !hardware.buttonsEnabled })}
                          className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                          style={{ background: hardware.buttonsEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                          aria-pressed={hardware.buttonsEnabled}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: hardware.buttonsEnabled ? 22 : 2 }} />
                        </button>
                      </div>

                      {/* Sensor */}
                      <div className="flex items-start justify-between gap-4 pt-1 border-t" style={{ borderColor: cardBdr }}>
                        <div className="flex-1 pt-4">
                          <span className="text-xs font-semibold" style={{ color: textPrimary }}>Presence sensor may control the timer</span>
                          <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                            Off means the sensor is still read, but only the buttons can start or stop a session.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => patchHardware({ sensorEnabled: !hardware.sensorEnabled })}
                          className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-4"
                          style={{ background: hardware.sensorEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                          aria-pressed={hardware.sensorEnabled}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: hardware.sensorEnabled ? 22 : 2 }} />
                        </button>
                      </div>

                      {hardware.sensorEnabled && (
                        <>
                          {/* Arm delay */}
                          <div className="flex flex-col gap-2">
                            <span className="text-xs font-semibold" style={{ color: textPrimary }}>Grace period before a session starts</span>
                            <p className="text-[11px] -mt-1" style={{ color: textSecondary }}>
                              After you sit down, the countdown runs on the LCD, the widget and the main header at
                              once. Leaving before it reaches zero cancels it. Set to 0 to start immediately.
                            </p>
                            <div className="flex items-center gap-2">
                              <NumberField
                                min={0}
                                max={300}
                                value={hardware.armSeconds}
                                onCommit={n => patchHardware({ armSeconds: n })}
                                ariaLabel="Grace period in seconds"
                                className="w-24 px-3 py-2 rounded-xl border text-xs outline-none"
                                style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                              />
                              <span className="text-[11px]" style={{ color: textSecondary }}>seconds</span>
                            </div>
                          </div>

                          {/* Away pause */}
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <span className="text-xs font-semibold" style={{ color: textPrimary }}>Pause when I leave the desk</span>
                              <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                                Briefly leaning out of the sensor's view will not trigger this — leaving has to be
                                sustained for several seconds before it counts.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => patchHardware({ awayPauseEnabled: !hardware.awayPauseEnabled })}
                              className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                              style={{ background: hardware.awayPauseEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                              aria-pressed={hardware.awayPauseEnabled}
                            >
                              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: hardware.awayPauseEnabled ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* Chaining sessions back to back */}
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <span className="text-xs font-semibold" style={{ color: textPrimary }}>Start the next session automatically</span>
                              <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                                When a session finishes and you are still sitting there, the grace period runs again
                                and the next one begins. Staying put produces no sensor reading to react to, so
                                without this the day stops after the first session. Stopping one yourself with the
                                terminate button does not restart it — leaving and returning does.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => patchHardware({ autoRestartEnabled: !hardware.autoRestartEnabled })}
                              className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                              style={{ background: hardware.autoRestartEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                              aria-pressed={hardware.autoRestartEnabled}
                            >
                              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: hardware.autoRestartEnabled ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* What happens when the app first becomes reachable */}
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <span className="text-xs font-semibold" style={{ color: textPrimary }}>Start a session when the app comes online</span>
                              <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                                The board is powered before the PC finishes booting, so it detects you long before
                                anything is listening. With this on, it re-reports the desk as occupied the moment a
                                window appears and you get the usual grace period, as though you had just sat down.
                                With it off, nothing happens until you actually leave and return.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => patchHardware({ announceOnConnect: !hardware.announceOnConnect })}
                              className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                              style={{ background: hardware.announceOnConnect ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                              aria-pressed={hardware.announceOnConnect}
                            >
                              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: hardware.announceOnConnect ? 22 : 2 }} />
                            </button>
                          </div>

                          {hardware.awayPauseEnabled && (
                            <div className="flex flex-col gap-2">
                              <span className="text-xs font-semibold" style={{ color: textPrimary }}>Terminate the session after being away for</span>
                              <p className="text-[11px] -mt-1" style={{ color: textSecondary }}>
                                Come back sooner and the paused session simply resumes. Stay away longer and it is
                                terminated exactly as pressing stop would — sitting down afterwards begins a new one.
                              </p>
                              <div className="flex items-center gap-2">
                                <NumberField
                                  min={10}
                                  max={3600}
                                  step={10}
                                  value={hardware.awayTerminateSeconds}
                                  onCommit={n => patchHardware({ awayTerminateSeconds: n })}
                                  ariaLabel="Terminate after away seconds"
                                  className="w-24 px-3 py-2 rounded-xl border text-xs outline-none"
                                  style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                                />
                                <span className="text-[11px]" style={{ color: textSecondary }}>
                                  seconds ({Math.round(hardware.awayTerminateSeconds / 6) / 10} min)
                                </span>
                              </div>
                            </div>
                          )}
                        </>
                      )}

                      {/* Sensor tuning — applied over WiFi, no reflashing */}
                      <div className="pt-4 border-t flex flex-col gap-4" style={{ borderColor: cardBdr }}>
                        <div>
                          <span className="text-xs font-semibold" style={{ color: textPrimary }}>Sensor tuning</span>
                          <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                            The board re-reads these every few seconds over WiFi, so it never has to be plugged into
                            the PC to be retuned. Use calibration below rather than guessing at the distances.
                          </p>
                        </div>

                        <HardwareCalibration
                          hardware={hardware}
                          patchHardware={patchHardware}
                          cardBg={cardBg}
                          cardBdr={cardBdr}
                          textPrimary={textPrimary}
                          textSecondary={textSecondary}
                        />

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>At desk below (cm)</span>
                            <NumberField
                              min={2} max={400} step={1}
                              value={hardware.enterCm}
                              onCommit={n => patchHardware({ enterCm: n })}
                              validateExtra={n => (n >= hardware.exitCm ? `Must stay below the away distance (${hardware.exitCm})` : null)}
                              ariaLabel="At desk below, cm"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Away above (cm)</span>
                            <NumberField
                              min={2} max={400} step={1}
                              value={hardware.exitCm}
                              onCommit={n => patchHardware({ exitCm: n })}
                              validateExtra={n => (n <= hardware.enterCm ? `Must stay above the at-desk distance (${hardware.enterCm})` : null)}
                              ariaLabel="Away above, cm"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                        </div>
                        <p className="text-[11px] -mt-2" style={{ color: textSecondary }}>
                          The gap between these two is deliberate: a reading sitting exactly on one threshold would
                          otherwise flip the state back and forth every sample.
                        </p>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Median window size</span>
                            <NumberField
                              min={1} max={MEDIAN_WINDOW_MAX} step={2} oddOnly
                              value={hardware.medianWindow}
                              onCommit={n => patchHardware({ medianWindow: n })}
                              ariaLabel="Median window size"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                            <span className="text-[10px]" style={{ color: textSecondary }}>
                              The board takes the <span style={{ color: textPrimary }}>median</span> (middle value) of
                              the last N readings, not the average — a wild reading sorts to an end and is discarded
                              outright, where an average would let it drag the result. At {hardware.medianWindow},
                              up to {Math.floor(hardware.medianWindow / 2)} bad reading
                              {Math.floor(hardware.medianWindow / 2) === 1 ? '' : 's'} in every {hardware.medianWindow} are
                              ignored. Odd numbers only, max {MEDIAN_WINDOW_MAX}.
                            </span>
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Time between readings (ms)</span>
                            <NumberField
                              min={40} max={2000} step={10}
                              value={hardware.sampleIntervalMs}
                              onCommit={n => patchHardware({ sampleIntervalMs: n })}
                              ariaLabel="Time between readings, ms"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Confirm arrival after (ms)</span>
                            <NumberField
                              min={0} max={60000} step={250}
                              value={hardware.presentConfirmMs}
                              onCommit={n => patchHardware({ presentConfirmMs: n })}
                              ariaLabel="Confirm arrival after, ms"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Confirm leaving after (ms)</span>
                            <NumberField
                              min={0} max={60000} step={250}
                              value={hardware.absentConfirmMs}
                              onCommit={n => patchHardware({ absentConfirmMs: n })}
                              ariaLabel="Confirm leaving after, ms"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                        </div>
                        <p className="text-[11px] -mt-2" style={{ color: textSecondary }}>
                          A state has to hold this long before it is believed. Leaving is usually given the longer
                          fuse, so briefly leaning out of the beam does not read as walking away.
                        </p>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Ignore readings beyond (cm)</span>
                            <NumberField
                              min={20} max={400} step={5}
                              value={hardware.maxValidCm}
                              onCommit={n => patchHardware({ maxValidCm: n })}
                              ariaLabel="Ignore readings beyond, cm"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>…unless they persist for (ms)</span>
                            <NumberField
                              min={0} max={60000} step={500}
                              value={hardware.glitchHoldMs}
                              onCommit={n => patchHardware({ glitchHoldMs: n })}
                              ariaLabel="Persist for, ms"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                        </div>
                        <p className="text-[11px] -mt-2" style={{ color: textSecondary }}>
                          Cheap ultrasonic modules sometimes spray maximum-range values for a second or two. Those are
                          dropped outright, so a burst cannot disturb a running session. They cannot be ignored
                          forever though — an empty desk with nothing in the beam reads exactly the same — so a run
                          lasting longer than {(hardware.glitchHoldMs / 1000).toFixed(0)}s is taken at face value.
                        </p>
                      </div>

                      <div className="pt-4 border-t flex items-center justify-between gap-4" style={{ borderColor: cardBdr }}>
                        <p className="text-[11px]" style={{ color: textSecondary }}>
                          Pin assignments and the WiFi credentials are the only things still fixed in the firmware.
                        </p>
                        <button
                          type="button"
                          onClick={() => setHardware(DEFAULT_HARDWARE_SETTINGS)}
                          className="px-3 py-2 rounded-xl border text-xs whitespace-nowrap"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        >
                          Reset to defaults
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </motion.div>
            )}

            {/* 🔗 INTEGRATIONS TAB */}
            {activeTab === 'integrations' && (
              <motion.div
                key="integrations"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Google Calendar Integration
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Sync your events bidirectionally with Google Calendar.
                    </p>
                  </div>

                  {/* Master Enable/Disable Toggle */}
                  <div className="p-4 rounded-2xl border flex items-center justify-between gap-4" style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', borderColor: cardBdr }}>
                    <div className="min-w-0 flex-1">
                      <span className="text-xs font-bold block" style={{ color: textPrimary }}>
                        Master Google Synchronization
                      </span>
                      <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>
                        {googleSyncEnabled
                          ? 'Google sync is enabled. The app will sync with Google Calendar & Tasks when connected.'
                          : 'Google sync is completely DISABLED. The app runs offline without contacting Google or showing warnings.'}
                      </span>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={googleSyncEnabled}
                      onClick={() => setGoogleSyncEnabled(v => !v)}
                      className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                      style={{ background: googleSyncEnabled ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)') }}
                    >
                      <span className="absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200" style={{ transform: googleSyncEnabled ? 'translateX(20px)' : 'translateX(0px)' }} />
                    </button>
                  </div>

                  <div className="p-4 rounded-2xl border flex flex-col gap-4" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="p-2.5 rounded-xl bg-blue-500/10 text-blue-500">
                          <Link2 size={20} />
                        </div>
                        <div>
                          <span className="text-xs font-bold block" style={{ color: textPrimary }}>
                            {gCalStatus.authenticated ? 'Connected to Google' : gCalStatus.configured ? 'OAuth Client Configured' : 'Not Connected'}
                          </span>
                          <span className="text-[11px] block mt-0.5" style={{ color: textSecondary }}>
                            {gCalStatus.email || 'Configure your Client ID & Secret to authorize Google Calendar.'}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className={`w-2.5 h-2.5 rounded-full ${gCalStatus.authenticated ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                      </div>
                    </div>

                    {!gCalStatus.configured ? (
                      <div className="flex flex-col gap-3 pt-3 border-t" style={{ borderColor: cardBdr }}>
                        <input
                          type="text"
                          placeholder="Client ID"
                          value={clientIdInput}
                          onChange={e => setClientIdInput(e.target.value)}
                          className="w-full py-2 px-3 text-xs rounded-xl border outline-none"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        />
                        <input
                          type="password"
                          placeholder="Client Secret"
                          value={clientSecretInput}
                          onChange={e => setClientSecretInput(e.target.value)}
                          className="w-full py-2 px-3 text-xs rounded-xl border outline-none"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        />
                        <button
                          onClick={() => {
                            if (!clientIdInput || !clientSecretInput) return;
                            fetch('/api/google-auth/setup', {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ clientId: clientIdInput, clientSecret: clientSecretInput, autoSync: true }),
                            })
                              .then(r => r.json())
                              .then(res => {
                                if (res.success) {
                                  setGCalStatus(prev => ({ ...prev, configured: true, autoSync: true }));
                                  showToast('Credentials saved successfully!', 'success');
                                }
                              });
                          }}
                          disabled={!clientIdInput || !clientSecretInput}
                          className="w-full py-2.5 px-4 rounded-xl text-xs font-bold transition-all text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
                        >
                          Save OAuth Credentials
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-col gap-3 pt-3 border-t" style={{ borderColor: cardBdr }}>
                        {!gCalStatus.authenticated ? (
                          <>
                            <RedirectUriHelp
                              textPrimary={textPrimary}
                              textSecondary={textSecondary}
                              cardBdr={cardBdr}
                              darkMode={darkMode}
                              onCopied={() => showToast('Redirect URI copied.', 'success')}
                            />
                            <button
                              onClick={() => {
                                const redirectUri = window.location.origin;
                                fetch(`/api/google-auth/url?redirectUri=${encodeURIComponent(redirectUri)}`)
                                  .then(r => r.json())
                                  .then(res => {
                                    if (res.url) {
                                      window.location.href = res.url;
                                    } else {
                                      showToast(res.error || 'Could not build the Google sign-in link.', 'error');
                                    }
                                  })
                                  .catch(() => showToast("Couldn't reach the server to start sign-in.", 'error'));
                              }}
                              className="w-full py-2.5 px-4 rounded-xl text-xs font-bold transition-all text-white bg-blue-600 hover:bg-blue-700"
                            >
                              Link Google Account
                            </button>
                          </>
                        ) : (
                          <div className="flex items-center justify-between gap-3">
                            <button
                              onClick={triggerGCalSync}
                              disabled={gCalSyncing}
                              className="flex-1 py-2.5 px-4 rounded-xl text-xs font-bold transition-all text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                              <RefreshCw size={14} className={gCalSyncing ? 'animate-spin' : ''} />
                              <span>{gCalSyncing ? 'Syncing...' : 'Sync Now'}</span>
                            </button>

                            <button
                              onClick={() => {
                                fetch('/api/google-auth/disconnect', { method: 'POST' })
                                  .then(r => r.json())
                                  .then(res => {
                                    if (res.success) {
                                      setGCalStatus({ configured: false, authenticated: false, autoSync: false });
                                      showToast('Google Account disconnected.', 'info');
                                    }
                                  });
                              }}
                              className="px-4 py-2.5 rounded-xl text-xs font-bold transition-all border text-red-400 border-red-500/20 hover:bg-red-500/10"
                            >
                              Disconnect
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                {/* Google Sync Policy & Modification Rules */}
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight flex items-center gap-2" style={{ color: textPrimary }}>
                      <ShieldCheck size={16} className="text-blue-500" />
                      Google Sync Policy & Modification Rules
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Configure direction, target calendars, and authority permissions between Google Calendar and this planner.
                    </p>
                  </div>

                  <div className="flex flex-col gap-4">
                    {/* Section A: App -> Google (Push) */}
                    <div className="p-4 rounded-2xl border flex flex-col gap-3" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                      <span className="text-[11px] font-bold uppercase tracking-wider text-blue-500">App → Google (Push Controls)</span>
                      
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Push local events to Google Calendar</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Create and update events on Google when authored in the planner</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gcalPushEnabled}
                          onClick={() => setGcalPushEnabled(v => !v)}
                          className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                          style={{ background: gcalPushEnabled ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm" style={{ left: gcalPushEnabled ? 22 : 2 }} />
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-2 border-t" style={{ borderColor: cardBdr }}>
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Google Calendar Destination</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Where newly created app events land on Google Calendar</span>
                        </div>
                        <select
                          value={gcalPushTarget}
                          onChange={e => setGcalPushTarget(e.target.value as 'daily' | 'primary')}
                          className="py-1.5 px-3 text-xs font-semibold rounded-xl border outline-none cursor-pointer flex-shrink-0"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        >
                          <option value="daily">Daily Calendar (Isolated & Recommended)</option>
                          <option value="primary">Primary Google Calendar</option>
                        </select>
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-2 border-t" style={{ borderColor: cardBdr }}>
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Allow updating external Google Calendar events</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Local edits to external Google Calendar cards will push back to their original calendar</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gcalPushOtherCalendars}
                          onClick={() => setGcalPushOtherCalendars(v => !v)}
                          className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                          style={{ background: gcalPushOtherCalendars ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm" style={{ left: gcalPushOtherCalendars ? 22 : 2 }} />
                        </button>
                      </div>
                    </div>

                    {/* Section B: Google -> App (Pull & Protection Rules) */}
                    <div className="p-4 rounded-2xl border flex flex-col gap-3" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                      <span className="text-[11px] font-bold uppercase tracking-wider text-emerald-500">Google → App (Pull & Protection Rules)</span>
                      
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Allow Google edits to modify Daily Calendar app items</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>
                            {gcalPullDailyEdits ? 'Google Calendar changes will overwrite local app items' : 'OFF (Recommended): App is sole source of truth; Google edits cannot touch local items'}
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gcalPullDailyEdits}
                          onClick={() => setGcalPullDailyEdits(v => !v)}
                          className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                          style={{ background: gcalPullDailyEdits ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm" style={{ left: gcalPullDailyEdits ? 22 : 2 }} />
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-2 border-t" style={{ borderColor: cardBdr }}>
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Import raw new events from Google Daily Calendar</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Import new items created directly on Google Calendar into the planner</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gcalPullDailyNew}
                          onClick={() => setGcalPullDailyNew(v => !v)}
                          className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                          style={{ background: gcalPullDailyNew ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm" style={{ left: gcalPullDailyNew ? 22 : 2 }} />
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-2 border-t" style={{ borderColor: cardBdr }}>
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Import events from other Google Calendars</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Display items from Primary, Work, and Personal Google Calendars as read-only cards</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gcalPullOtherCalendars}
                          onClick={() => setGcalPullOtherCalendars(v => !v)}
                          className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                          style={{ background: gcalPullOtherCalendars ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm" style={{ left: gcalPullOtherCalendars ? 22 : 2 }} />
                        </button>
                      </div>
                    </div>

                    {/* Section C: Deletion Rules */}
                    <div className="p-4 rounded-2xl border flex flex-col gap-3" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                      <span className="text-[11px] font-bold uppercase tracking-wider text-purple-500">Deletion Mirroring Rules</span>
                      
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Deleting in app deletes on Google Calendar</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Removing an event in the planner issues a DELETE call to Google Calendar</span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gcalMirrorLocalDeletions}
                          onClick={() => setGcalMirrorLocalDeletions(v => !v)}
                          className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                          style={{ background: gcalMirrorLocalDeletions ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm" style={{ left: gcalMirrorLocalDeletions ? 22 : 2 }} />
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-3 pt-2 border-t" style={{ borderColor: cardBdr }}>
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Deleting on Google Calendar deletes in app</span>
                          <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>
                            {gcalMirrorGoogleDeletions ? 'Deleting an item on Google Calendar wipes it locally' : 'OFF (Protected): Items deleted on Google Calendar will stay safe in your local planner'}
                          </span>
                        </div>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={gcalMirrorGoogleDeletions}
                          onClick={() => setGcalMirrorGoogleDeletions(v => !v)}
                          className="relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                          style={{ background: gcalMirrorGoogleDeletions ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                        >
                          <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all shadow-sm" style={{ left: gcalMirrorGoogleDeletions ? 22 : 2 }} />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Google Tasks */}
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Google Tasks Integration</h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Two-way sync with your <strong>Daily Tasks</strong> list — create, edit, complete or delete from either side.
                    </p>
                  </div>

                  {gCalStatus.authenticated && !gCalStatus.hasTasksScope && (
                    <div
                      className="p-4 rounded-2xl border flex items-start gap-3"
                      style={{ background: 'rgba(245,158,11,0.08)', borderColor: 'rgba(245,158,11,0.35)' }}
                    >
                      <AlertCircle size={17} className="text-amber-500 flex-shrink-0 mt-0.5" />
                      <div className="flex flex-col gap-2.5 min-w-0">
                        <div>
                          <span className="text-xs font-bold block" style={{ color: textPrimary }}>
                            One more permission needed
                          </span>
                          <span className="text-[11px] block mt-0.5" style={{ color: textSecondary }}>
                            Your Google connection was authorised for Calendar only, so tasks sync is paused.
                            Reconnecting grants both — nothing else changes and your events are untouched.
                          </span>
                        </div>
                        <button
                          onClick={() => {
                            const redirectUri = window.location.origin;
                            fetch(`/api/google-auth/url?redirectUri=${encodeURIComponent(redirectUri)}`)
                              .then(r => r.json())
                              .then(res => { if (res.url) window.location.href = res.url; });
                          }}
                          className="self-start py-2 px-4 rounded-xl text-xs font-bold transition-all text-white bg-amber-600 hover:bg-amber-700"
                        >
                          Reconnect Google
                        </button>
                      </div>
                    </div>
                  )}

                  <label className="flex items-center justify-between gap-4 cursor-pointer">
                    <span className="flex flex-col min-w-0">
                      <span className="text-xs font-semibold" style={{ color: textPrimary }}>Sync tasks with Google</span>
                      <span className="text-[11px]" style={{ color: textSecondary }}>
                        Repeating tasks can't be expressed in the Tasks API, so the repeat rule stays in the planner
                        and Google always holds just the next due occurrence. Times ride along as a “⏰ HH:MM” line in the notes.
                      </span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setGoogleTasksSync(v => !v)}
                      className="relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                      style={{ background: googleTasksSync ? accentColor : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={googleTasksSync}
                    >
                      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all" style={{ left: googleTasksSync ? 22 : 2 }} />
                    </button>
                  </label>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* ── Toast Notifications Stack ───────────────────────────────────────── */}
      <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2.5 max-w-sm w-full pointer-events-none">
        <AnimatePresence>
          {toasts.map(t => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 16, scale: 0.95 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.95 }}
              className="p-4 rounded-2xl shadow-xl border flex items-center gap-3 pointer-events-auto backdrop-blur-md"
              style={{
                background: darkMode ? 'rgba(24, 27, 32, 0.95)' : 'rgba(255, 255, 255, 0.95)',
                borderColor: t.tone === 'error' ? 'rgba(239, 68, 68, 0.3)' : t.tone === 'success' ? 'rgba(16, 185, 129, 0.3)' : cardBdr,
                color: textPrimary,
              }}
            >
              {t.tone === 'success' && <CheckCircle2 size={18} className="text-emerald-500" />}
              {t.tone === 'error' && <AlertCircle size={18} className="text-red-500" />}
              {t.tone === 'info' && <Sparkles size={18} className="text-blue-500" />}
              <span className="text-xs font-medium flex-1">{t.message}</span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}
