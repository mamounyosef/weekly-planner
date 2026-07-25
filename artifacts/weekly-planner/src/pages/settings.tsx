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

type TimeFormat = '12h' | '24h';
type IntervalMin = 5 | 15 | 30 | 60;
type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface AutoBackupCfg {
  enabled: boolean;
  intervalHours: number;
  keep: number;
}

const AUTO_BACKUP_DEFAULT: AutoBackupCfg = { enabled: true, intervalHours: 24, keep: 50 };

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

type TabCategory = 'appearance' | 'calendar' | 'audio' | 'shortcuts' | 'backup' | 'integrations';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

export default function SettingsPage() {
  const [, setLocation] = useLocation();

  // Active Sidebar Tab
  const [activeTab, setActiveTab] = useState<TabCategory>('appearance');

  // Settings states
  const [interval, setIntervalOpt] = useState<IntervalMin>(15);
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>('12h');
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(1);
  const [dayStartH, setDayStartH] = useState<number>(8);
  const [dayEndH, setDayEndH] = useState<number>(18);
  const [focusDayStartHour, setFocusDayStartHour] = useState<number>(4);
  const [focusChime, setFocusChime] = useState<FocusChimeId>('bowl');
  const [focusCues, setFocusCues] = useState<{ start: FocusCueId; pause: FocusCueId; resume: FocusCueId }>({
    start: 'gentle-up',
    pause: 'gentle-down',
    resume: 'gentle-up',
  });
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(DEFAULT_SHORTCUTS);
  const [autoBackup, setAutoBackup] = useState<AutoBackupCfg>(AUTO_BACKUP_DEFAULT);
  const [recordingAction, setRecordingAction] = useState<ShortcutAction | null>(null);

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

  const settingsLoaded = useRef(false);

  // Load Initial Settings from backend & LocalStorage
  useEffect(() => {
    // Sync dark mode class on document element if needed
    if (darkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [darkMode]);

  useEffect(() => {
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
      .catch(err => console.error('Failed to load settings:', err))
      .finally(() => {
        settingsLoaded.current = true;
      });

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

  // Save Settings whenever state changes
  useEffect(() => {
    if (!settingsLoaded.current) return;
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        interval,
        darkMode,
        timeFormat,
        weekStartsOn,
        dayStartH,
        dayEndH,
        focusDayStartHour,
        focusChime,
        focusCues,
        shortcuts,
        autoBackup,
      }),
    }).catch(err => console.error('Failed to save settings:', err));
  }, [interval, darkMode, timeFormat, weekStartsOn, dayStartH, dayEndH, focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup]);

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

  const exportBackup = async () => {
    try {
      const res = await fetch('/api/events');
      const events = await res.json();
      const backupData = {
        backupFormatVersion: 2,
        exportedAt: new Date().toISOString(),
        events,
        settings: { interval, darkMode, timeFormat, weekStartsOn, dayStartH, dayEndH, focusDayStartHour, focusChime, focusCues, autoBackup },
        shortcuts,
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
        if (confirm('Import backup? This will merge/update events and restore settings.')) {
          await fetch('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(incomingEvents),
          });
          if (parsed.settings) {
            const s = parsed.settings;
            if (s.interval != null) setIntervalOpt(s.interval);
            if (typeof s.darkMode === 'boolean') setDarkMode(s.darkMode);
            if (s.timeFormat) setTimeFormat(s.timeFormat);
            if (s.weekStartsOn != null) setWeekStartsOn(s.weekStartsOn);
            if (s.dayStartH != null) setDayStartH(s.dayStartH);
            if (s.dayEndH != null) setDayEndH(s.dayEndH);
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

  const triggerGCalSync = () => {
    setGCalSyncing(true);
    fetch('/api/google-auth/sync', { method: 'POST' })
      .then(r => r.json())
      .then(res => {
        if (res.success) {
          showToast(`Google Calendar synced (${res.synced || 0} events).`, 'success');
        } else {
          showToast(res.error || 'Google Sync failed.', 'error');
        }
      })
      .catch(() => showToast('Failed to connect to Google Sync server.', 'error'))
      .finally(() => setGCalSyncing(false));
  };

  // Color tokens
  const bgMain = darkMode ? '#0f1115' : '#f8fafc';
  const cardBg = darkMode ? '#181b20' : '#ffffff';
  const cardBdr = darkMode ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
  const textPrimary = darkMode ? '#f1f5f9' : '#0f172a';
  const textSecondary = darkMode ? '#94a3b8' : '#64748b';
  const accentColor = '#3b82f6';
  const accentLight = darkMode ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.08)';

  const tabs: { id: TabCategory; label: string; icon: React.ReactNode; badge?: string }[] = [
    { id: 'appearance', label: 'Appearance', icon: <Sun size={17} /> },
    { id: 'calendar', label: 'Calendar Grid', icon: <Calendar size={17} /> },
    { id: 'audio', label: 'Focus & Audio', icon: <Volume2 size={17} /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={17} /> },
    { id: 'backup', label: 'Backups & Data', icon: <Database size={17} /> },
    { id: 'integrations', label: 'Integrations', icon: <Link2 size={17} />, badge: gCalStatus.authenticated ? 'Connected' : undefined },
  ];

  return (
    <div
      className="min-h-screen flex flex-col font-sans transition-colors duration-300"
      style={{ background: bgMain, color: textPrimary }}
    >
      {/* ── Top Header Navigation Bar ────────────────────────────────────────── */}
      <header
        className="sticky top-0 z-50 flex items-center justify-between px-6 py-4 border-b backdrop-blur-md transition-colors"
        style={{
          background: darkMode ? 'rgba(24, 27, 32, 0.85)' : 'rgba(255, 255, 255, 0.85)',
          borderColor: cardBdr,
        }}
      >
        <div className="flex items-center gap-4">
          <button
            onClick={() => setLocation('/')}
            className="flex items-center gap-2 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all duration-200 hover:scale-[1.02] active:scale-[0.98]"
            style={{
              background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              border: `1px solid ${cardBdr}`,
              color: textPrimary,
            }}
          >
            <ArrowLeft size={16} />
            <span>Back to Planner</span>
          </button>

          <div className="h-5 w-[1px]" style={{ background: cardBdr }} />

          <div className="flex items-center gap-2.5">
            <div
              className="p-2 rounded-xl flex items-center justify-center shadow-sm"
              style={{ background: accentLight, color: accentColor }}
            >
              <Sliders size={18} />
            </div>
            <div>
              <h1 className="text-base font-bold tracking-tight" style={{ color: textPrimary }}>
                Settings & Preferences
              </h1>
              <p className="text-[11px] font-medium" style={{ color: textSecondary }}>
                Customize your workspace, layout, and shortcuts
              </p>
            </div>
          </div>
        </div>

        {/* Header Right Controls */}
        <div className="flex items-center gap-3">
          {/* Dark Mode Quick Toggle */}
          <button
            onClick={() => setDarkMode(d => !d)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl text-xs font-medium transition-all"
            style={{
              background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
              border: `1px solid ${cardBdr}`,
              color: textPrimary,
            }}
            title="Toggle Dark / Light Mode"
          >
            {darkMode ? <Moon size={15} className="text-indigo-400" /> : <Sun size={15} className="text-amber-500" />}
            <span className="capitalize">{darkMode ? 'Dark' : 'Light'}</span>
          </button>

          <span className="text-[11px] font-mono px-2 py-1 rounded-md" style={{ background: darkMode ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', color: textSecondary }}>
            Esc to exit
          </span>
        </div>
      </header>

      {/* ── Main Layout Body ────────────────────────────────────────────────── */}
      <div className="flex-1 flex max-w-7xl w-full mx-auto px-6 py-8 gap-8">
        {/* Sidebar Navigation */}
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

        {/* Content Container */}
        <main className="flex-1 flex flex-col gap-6">
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
                <div className="p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Appearance & Theme
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Choose your preferred color theme and interface layout.
                    </p>
                  </div>

                  {/* Dark Mode Card */}
                  <div className="flex items-center justify-between p-4 rounded-2xl border" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                    <div className="flex items-center gap-3">
                      <div className="p-2.5 rounded-xl" style={{ background: darkMode ? 'rgba(129, 140, 248, 0.15)' : 'rgba(245, 158, 11, 0.15)', color: darkMode ? '#818cf8' : '#f59e0b' }}>
                        {darkMode ? <Moon size={20} /> : <Sun size={20} />}
                      </div>
                      <div>
                        <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Dark Mode</span>
                        <span className="text-[11px] block" style={{ color: textSecondary }}>Sleek, high-contrast dark palette tailored for night focus</span>
                      </div>
                    </div>

                    <button
                      onClick={() => setDarkMode(d => !d)}
                      className="relative w-12 h-6.5 rounded-full transition-colors duration-200"
                      style={{
                        background: darkMode ? '#3b82f6' : 'rgba(0,0,0,0.15)',
                      }}
                    >
                      <span
                        className="absolute top-1 left-1 w-4.5 h-4.5 rounded-full bg-white transition-transform duration-200 shadow-md"
                        style={{
                          transform: darkMode ? 'translateX(22px)' : 'translateX(0px)',
                        }}
                      />
                    </button>
                  </div>

                  {/* Time Format */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Time Display Format
                    </span>
                    <div className="grid grid-cols-2 gap-3">
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
                <div className="p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
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
                    <div className="grid grid-cols-4 gap-3">
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
                    <div className="grid grid-cols-2 gap-4 p-4 rounded-2xl border" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
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
                <div className="p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
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
                <div className="p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
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
                      <div className="grid grid-cols-2 gap-3">
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
                <div className="p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
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
                    <div className="flex items-center justify-between">
                      <div>
                        <span className="text-xs font-bold block" style={{ color: textPrimary }}>Automatic Local Backups</span>
                        <span className="text-[11px] block mt-0.5" style={{ color: textSecondary }}>Automatically save snapshots into your local project directory</span>
                      </div>

                      <button
                        onClick={() => setAutoBackup(c => ({ ...c, enabled: !c.enabled }))}
                        className="relative w-12 h-6.5 rounded-full transition-colors duration-200"
                        style={{ background: autoBackup.enabled ? '#10b981' : 'rgba(0,0,0,0.15)' }}
                      >
                        <span
                          className="absolute top-1 left-1 w-4.5 h-4.5 rounded-full bg-white transition-transform duration-200 shadow-md"
                          style={{ transform: autoBackup.enabled ? 'translateX(22px)' : 'translateX(0px)' }}
                        />
                      </button>
                    </div>

                    <div className="grid grid-cols-2 gap-4 pt-3 border-t" style={{ borderColor: cardBdr }}>
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
                        <input
                          type="number"
                          min={1}
                          max={500}
                          value={autoBackup.keep}
                          onChange={e => setAutoBackup(c => ({ ...c, keep: Math.max(1, parseInt(e.target.value) || 1) }))}
                          disabled={!autoBackup.enabled}
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
                  <div className="grid grid-cols-2 gap-4">
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
                <div className="p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      Google Calendar Integration
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Sync your events bidirectionally with Google Calendar.
                    </p>
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
                            className="w-full py-2.5 px-4 rounded-xl text-xs font-bold transition-all text-white bg-blue-600 hover:bg-blue-700"
                          >
                            Link Google Account
                          </button>
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
