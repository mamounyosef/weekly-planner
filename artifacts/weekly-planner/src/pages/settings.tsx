import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useLocation } from 'wouter';
import { motion, AnimatePresence, MotionConfig, Reorder, useDragControls, type HTMLMotionProps } from 'framer-motion';
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
  Minus,
  Plus,
  Smartphone,
  Tag,
  FolderKanban,
  Edit2,
  Trash2,
  Palette,
  GripVertical,
  Square,
  CheckSquare,
  Repeat,
  Eye,
  EyeOff,
  User,
  LogOut,
  Globe,
  Wifi,
  Copy,
  ExternalLink,
  Bell,
  BellOff,
  BellRing,
  AlarmClock,
  MonitorSmartphone,
  Send,
  Activity,
  ShieldAlert,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import {
  FOCUS_CHIMES,
  FOCUS_CUES,
  DEFAULT_FOCUS_CHIME,
  DEFAULT_FOCUS_CUES,
  FocusChimeId,
  FocusChimeCategory,
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
  FOCUS_TIMER_TOGGLE_DEFAULT,
  SHORTCUT_DEFAULTS_VERSION,
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
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  offsetChip,
  offsetLabel,
  resolveSpec,
  type NotificationSettings,
  type NotifySpec,
} from '@/lib/notifications';
import { isInstalledApp, primeNotificationAudio, useNotifications } from '@/lib/notificationClient';
import { NotifyEditor, type NotifyTheme } from '@/components/NotifyEditor';
import { DEFAULT_HARDWARE_SETTINGS, type HardwareSettings } from '@/lib/hardwareController';
import { NumberField } from '@/components/NumberField';
import { useViewport, haptic } from '@/hooks/use-mobile';
import {
  DEVICE_SCOPED_KEYS,
  FilterViewKey,
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
import {
  DEFAULT_CATEGORIES,
  PRESET_CATEGORY_COLORS,
  type EventCategory,
} from '@/lib/categories';
import {
  coerceTaskLists, GENERAL_LIST_ID, TASK_LIST_COLORS, makeListId, nextListColor,
  type TaskList,
} from '@/lib/taskLists';
import { gcalChipColors } from '@/lib/gcalColor';
import { CanvasAmbient, CanvasAmbientPreview } from '@/components/CanvasAmbient';
import { EventCardPreviewPair } from '@/components/EventCardPreview';

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
            className="touch-target flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-lg border text-left transition-colors"
            style={{ borderColor: cardBdr, background: darkMode ? 'rgba(0,0,0,0.25)' : '#fff' }}
            title="Copy"
          >
            {/* min-w-0, or a long origin refuses to shrink and pushes the row
                off a narrow screen instead of truncating. */}
            <code className="text-[11px] font-mono truncate min-w-0" style={{ color: textPrimary }}>{u}</code>
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
/**
 * The presence filter's own working, live.
 *
 * Presence used to be decided on the ESP32, where a wrong verdict left nothing
 * behind to look at — the board reported "away" and the only recourse was to
 * guess which of the thresholds or timers had been wrong. It is decided on the
 * PC now, so the evidence can simply be shown: how much of the recent window
 * agreed with the believed distance, how far apart the readings are, whether a
 * departure is being counted down or actively withheld, and why.
 */
function FilterReadout({ f, textPrimary, textSecondary, cardBdr }: {
  f: Record<string, unknown>;
  textPrimary: string;
  textSecondary: string;
  cardBdr: string;
}) {
  const num = (k: string) => (typeof f[k] === 'number' ? (f[k] as number) : 0);
  const pct = (k: string) => `${Math.round(num(k) * 100)}%`;
  const holding = typeof f.holding === 'string' ? f.holding : null;
  const awayNeeds = num('awayNeedsMs');
  const arriveNeeds = num('arriveNeedsMs');

  // Phrased as what it means for the desk, not as what the code calls it.
  const HOLD_TEXT: Record<string, string> = {
    'near-reading': 'something is still reading close — you are demonstrably here',
    'unstable': 'the readings disagree too much to be one object',
    'no-consensus': 'no group of readings is big enough to speak for the window',
    'ramp-masked': 'the readings are mid-jump; waiting for them to settle',
    'over-range-ignored': 'over-range readings never count as away on this desk',
  };

  const rows: Array<[string, string]> = [
    ['Agreement', `${pct('support')} of the last ${num('windowCount')} readings`],
    ['Spread', `${num('spreadCm').toFixed(0)}cm`],
    ['Close readings', pct('nearRatio')],
    ['Over-range readings', pct('overRatio')],
  ];

  return (
    <div className="rounded-xl border p-3 flex flex-col gap-2" style={{ borderColor: cardBdr }}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-1">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-2">
            <span className="text-[10px]" style={{ color: textSecondary }}>{label}</span>
            <span className="text-[10px] font-semibold tabular-nums" style={{ color: textPrimary }}>{value}</span>
          </div>
        ))}
      </div>

      {f.masked === true && (
        <p className="text-[10px]" style={{ color: '#f59e0b' }}>
          Ignoring the current readings — they are jumping in strides no body makes, which is a beam losing its
          reflector rather than someone leaving.
        </p>
      )}

      {holding ? (
        <p className="text-[10px]" style={{ color: '#f59e0b' }}>
          Holding you at the desk: {HOLD_TEXT[holding] ?? holding}
          {num('holdingMs') > 1000 ? ` (${(num('holdingMs') / 1000).toFixed(0)}s so far)` : ''}.
        </p>
      ) : awayNeeds > 0 && num('awayProgressMs') > 0 ? (
        <p className="text-[10px]" style={{ color: textSecondary }}>
          Counting down to away: {(num('awayProgressMs') / 1000).toFixed(1)}s of {(awayNeeds / 1000).toFixed(0)}s.
        </p>
      ) : arriveNeeds > 0 && num('arriveProgressMs') > 0 ? (
        <p className="text-[10px]" style={{ color: textSecondary }}>
          Counting down to at-desk: {(num('arriveProgressMs') / 1000).toFixed(1)}s of {(arriveNeeds / 1000).toFixed(0)}s.
        </p>
      ) : null}

      {f.everEchoed === false && (
        <p className="text-[10px]" style={{ color: '#ef4444' }}>
          The sensor has not returned a single echo. A disconnected module reads exactly like an empty desk, so
          nothing is being decided until one arrives.
        </p>
      )}
      {f.forced === true && (
        <p className="text-[10px]" style={{ color: '#ef4444' }}>
          Gave up waiting for the readings to make sense and called it away. If this keeps happening, the sensor is
          aimed at something it cannot get a clean echo off.
        </p>
      )}
    </div>
  );
}

function HardwareCalibration({ hardware, patchHardware, cardBg, cardBdr, textPrimary, textSecondary }: {
  hardware: HardwareSettings;
  patchHardware: (patch: Partial<HardwareSettings>) => void;
  cardBg: string;
  cardBdr: string;
  textPrimary: string;
  textSecondary: string;
}) {
  const [live, setLive] = useState<number | null>(null);
  const [liveRaw, setLiveRaw] = useState<number | null>(null);
  const [livePresent, setLivePresent] = useState<boolean | null>(null);
  const [liveFilter, setLiveFilter] = useState<Record<string, unknown> | null>(null);
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
        setLiveRaw(typeof data?.rawCm === 'number' ? data.rawCm : null);
        setLivePresent(typeof data?.present === 'boolean' ? data.present : null);
        setLiveFilter(data?.filter && typeof data.filter === 'object' ? data.filter : null);
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
          className="touch-target px-3 py-1.5 rounded-lg border text-[11px] flex-shrink-0"
          style={{
            background: hardware.calibrating ? '#3b82f6' : cardBg,
            borderColor: hardware.calibrating ? '#3b82f6' : cardBdr,
            color: hardware.calibrating ? '#fff' : textPrimary,
          }}
        >
          {hardware.calibrating ? 'Stop' : 'Start calibration'}
        </button>
      </div>

      {/* Live readout, shown whether or not calibration is running. Wraps: the
          number, its two captions and the state pill are wider than a phone. */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-baseline gap-2 flex-wrap min-w-0">
          <span className="text-2xl font-semibold tabular-nums" style={{ color: textPrimary }}>
            {live === null ? '--' : live.toFixed(1)}
          </span>
          <span className="text-[11px]" style={{ color: textSecondary }}>
            {live === null ? 'board not reporting' : 'cm believed'}
          </span>
          {liveRaw !== null && (
            <span className="text-[11px] tabular-nums" style={{ color: textSecondary }}>
              · raw {liveRaw <= 0 ? 'no echo' : `${liveRaw.toFixed(0)}cm`}
            </span>
          )}
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
          whatever it already decided. The believed number is the middle of the largest group of readings that agree
          with each other — not the raw ping, which is what makes a blocked sensor survivable.
        </p>
      )}

      {/* What the filter is doing with those readings right now. Presence used
          to be decided on the board, where the only way to find out why it had
          gone wrong was to guess. Every number the decision rests on is here. */}
      {liveFilter && <FilterReadout f={liveFilter} textPrimary={textPrimary} textSecondary={textSecondary} cardBdr={cardBdr} />}

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
/**
 * A category's reminder override. Shown as "following the global default" until
 * it is customised, because a category that silently froze today's global
 * default the moment it was created would be impossible to reason about later.
 */
function CategoryNotifyBlock({
  label, spec, fallback, kind, onChange, theme, cardBdr, textPrimary, textSecondary, hint,
}: {
  label: string;
  spec: NotifySpec | undefined;
  fallback: NotifySpec;
  kind: 'timed' | 'allDay';
  onChange: (next: NotifySpec | undefined) => void;
  theme: NotifyTheme;
  cardBdr: string;
  textPrimary: string;
  textSecondary: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl p-2.5 flex flex-col gap-1.5" style={{ border: `1px solid ${cardBdr}` }}>
      <p className="text-[11.5px] font-semibold" style={{ color: textPrimary }}>{label}</p>
      {hint && <p className="text-[10.5px]" style={{ color: textSecondary }}>{hint}</p>}
      <NotifyEditor
        spec={spec}
        effective={spec ?? fallback}
        onChange={onChange}
        inheritedFrom="the global default"
        kind={kind}
        theme={theme}
      />
    </div>
  );
}

/** One row of the delivery-health list. */
function HealthRow({
  label, ok, detail, textPrimary, textSecondary, cardBdr,
}: {
  label: string; ok: boolean; detail: string;
  textPrimary: string; textSecondary: string; cardBdr: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-xl px-3 py-2" style={{ border: `1px solid ${cardBdr}` }}>
      <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: ok ? '#22c55e' : '#ef4444' }} />
      <span className="text-[12px] font-medium" style={{ color: textPrimary }}>{label}</span>
      <span className="text-[10.5px] ml-auto text-right truncate" style={{ color: textSecondary }}>{detail}</span>
    </div>
  );
}

/** A labelled switch row, used throughout the notification settings. */
function ToggleRow({
  label, hint, value, onChange, accentColor, darkMode, cardBdr, textPrimary, textSecondary, noBorder,
}: {
  label: string; hint: string; value: boolean; onChange: (v: boolean) => void;
  accentColor: string; darkMode: boolean; cardBdr: string;
  textPrimary: string; textSecondary: string; noBorder?: boolean;
}) {
  return (
    <div
      className="flex items-start justify-between gap-3 py-2"
      style={noBorder ? undefined : { borderBottom: `1px solid ${cardBdr}` }}
    >
      <div className="min-w-0">
        <p className="text-[12.5px] font-medium" style={{ color: textPrimary }}>{label}</p>
        <p className="text-[11px] mt-0.5 max-w-[54ch]" style={{ color: textSecondary }}>{hint}</p>
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
        style={{ background: value ? accentColor : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
        aria-pressed={value}
      >
        <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: value ? 22 : 2 }} />
      </button>
    </div>
  );
}

/**
 * One default rule set. These are the bottom of the inheritance chain, so there
 * is nothing for them to fall back to and the editor hides its inherit control.
 */
function DefaultBlock({
  title, hint, spec, kind, onChange, theme, cardBdr, textPrimary, textSecondary, extra,
}: {
  title: string;
  hint: string;
  spec: NotifySpec;
  kind: 'timed' | 'allDay' | 'task';
  onChange: (next: NotifySpec) => void;
  theme: NotifyTheme;
  cardBdr: string;
  textPrimary: string;
  textSecondary: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 pt-3" style={{ borderTop: `1px solid ${cardBdr}` }}>
      <div>
        <p className="text-[12.5px] font-semibold" style={{ color: textPrimary }}>{title}</p>
        <p className="text-[11px] mt-0.5 max-w-[60ch]" style={{ color: textSecondary }}>{hint}</p>
      </div>
      {extra}
      <NotifyEditor
        spec={spec}
        effective={spec}
        onChange={next => onChange(next ?? spec)}
        inheritedFrom={null}
        kind={kind}
        theme={theme}
      />
    </div>
  );
}

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
            className="p-3.5 rounded-2xl border text-left flex flex-col gap-2 transition-smooth relative overflow-hidden cursor-pointer hover:scale-[1.02]"
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

type TabCategory = 'appearance' | 'calendar' | 'categories' | 'notifications' | 'prayer' | 'audio' | 'shortcuts' | 'backup' | 'integrations' | 'hardware' | 'account';

interface Toast {
  id: number;
  message: string;
  tone: 'info' | 'success' | 'error';
}

function CategoryRow({
  cat,
  darkMode,
  accentColor,
  cardBdr,
  textPrimary,
  textSecondary,
  eventColorStyle,
  activeTheme,
  deleteConfirmCatId,
  onOpenEdit,
  onSetDefault,
  onSetDeleteConfirm,
  onDelete,
}: {
  cat: EventCategory;
  darkMode: boolean;
  accentColor: string;
  cardBdr: string;
  textPrimary: string;
  textSecondary: string;
  eventColorStyle: EventCardStyle;
  activeTheme: { rootBg: string };
  deleteConfirmCatId: string | null;
  onOpenEdit: () => void;
  onSetDefault: () => void;
  onSetDeleteConfirm: (id: string | null) => void;
  onDelete: () => void;
}) {
  const controls = useDragControls();
  const previewStyle = gcalChipColors(cat.color, { dark: darkMode, style: eventColorStyle, pageBg: activeTheme.rootBg });

  return (
    <Reorder.Item
      value={cat}
      id={cat.id}
      dragListener={false}
      dragControls={controls}
      className="p-4 rounded-2xl border flex flex-col gap-3 group select-none relative"
      style={{
        background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.015)',
        borderColor: cardBdr,
      }}
      whileDrag={{
        scale: 1.02,
        boxShadow: `0 20px 40px -8px rgba(0,0,0,0.5), 0 0 0 2px ${accentColor}`,
        background: darkMode ? 'rgba(255,255,255,0.08)' : '#ffffff',
        zIndex: 50,
      }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Left: Grip + Color dot + Name + Default Badge */}
        <div className="flex items-center gap-3">
          <div
            onPointerDown={e => {
              e.preventDefault();
              controls.start(e);
            }}
            className="cursor-grab active:cursor-grabbing p-1.5 -m-1.5 touch-none rounded-lg hover:bg-white/10 transition-colors flex items-center justify-center"
            title="Drag to reorder"
          >
            <GripVertical
              size={16}
              className="flex-shrink-0 opacity-70 sm:opacity-40 sm:group-hover:opacity-90 transition-opacity"
              style={{ color: textSecondary }}
            />
          </div>
          <div
            className="w-5 h-5 rounded-full flex-shrink-0 shadow-sm border"
            style={{
              backgroundColor: cat.color,
              borderColor: darkMode ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)',
            }}
          />
          <div className="flex flex-col">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-bold" style={{ color: textPrimary }}>
                {cat.name}
              </span>
              {cat.isDefault && (
                <span className="text-[9px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 flex items-center gap-1">
                  <Check size={10} /> Default
                </span>
              )}
              <span className="text-[10.5px] font-mono opacity-60" style={{ color: textSecondary }}>
                {cat.color}
              </span>
            </div>
            {cat.description && (
              <span className="text-[11.5px] mt-0.5" style={{ color: textSecondary }}>
                {cat.description}
              </span>
            )}
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5 self-end sm:self-center">
          {!cat.isDefault && (
            <button
              type="button"
              onClick={onSetDefault}
              className="px-2.5 h-7 rounded-lg text-[11px] font-medium border flex items-center gap-1.5 transition-smooth hover:bg-white/5"
              style={{ borderColor: cardBdr, color: textSecondary }}
              title="Set as default category for new items"
            >
              <Check size={11} className="opacity-40" />
              Make Default
            </button>
          )}

          <button
            type="button"
            onClick={onOpenEdit}
            className="touch-target px-2.5 h-7 rounded-lg text-[11px] font-medium border flex items-center gap-1.5 transition-smooth hover:bg-white/5"
            style={{ borderColor: cardBdr, color: textPrimary }}
          >
            <Edit2 size={11} />
            Edit
          </button>

          {deleteConfirmCatId === cat.id ? (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={onDelete}
                className="touch-target px-2 h-7 rounded-lg text-[10.5px] font-bold bg-rose-500/20 text-rose-400 border border-rose-500/30 hover:bg-rose-500/30 transition-smooth"
              >
                Confirm
              </button>
              <button
                type="button"
                onClick={() => onSetDeleteConfirm(null)}
                className="touch-target px-1.5 h-7 rounded-lg text-[10.5px] border transition-smooth"
                style={{ borderColor: cardBdr, color: textSecondary }}
              >
                <X size={12} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => onSetDeleteConfirm(cat.id)}
              className="touch-target w-7 h-7 rounded-lg border flex items-center justify-center text-xs transition-smooth hover:bg-rose-500/10 hover:text-rose-400 hover:border-rose-500/30"
              style={{ borderColor: cardBdr, color: textSecondary }}
              title="Delete category"
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Category Settings Badges Row & Live Sample Preview */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pt-2 border-t" style={{ borderColor: cardBdr }}>
        <div className="flex items-center gap-2 flex-wrap text-[11px]" style={{ color: textSecondary }}>
          <span className="px-2 py-0.5 rounded-md bg-muted/20 border border-border/30 flex items-center gap-1">
            <Clock size={11} /> {cat.defaultNoDuration || cat.defaultDurationMin === 0 ? 'Point in Time (10m space)' : `Default: ${cat.defaultDurationMin ?? 30}m`}
          </span>
          {/* Only shown once the category actually overrides the default: a
              chip that appears on every category would say nothing. */}
          {(cat.defaultAllDay ? cat.notifyAllDay : cat.notifyTimed) && (() => {
            const spec = (cat.defaultAllDay ? cat.notifyAllDay : cat.notifyTimed)!;
            const critical = spec.priority === 'critical';
            return (
              <span
                className="px-2 py-0.5 rounded-md flex items-center gap-1"
                style={{
                  background: critical ? 'rgba(239,68,68,0.14)' : 'rgba(59,130,246,0.14)',
                  border: `1px solid ${critical ? 'rgba(239,68,68,0.3)' : 'rgba(59,130,246,0.3)'}`,
                  color: critical ? '#f87171' : '#60a5fa',
                }}
                title={spec.enabled
                  ? spec.rules.map(r => offsetLabel(r.offsetMin)).join(', ')
                  : 'Items in this category are not reminded about'}
              >
                {spec.enabled ? <Bell size={11} /> : <BellOff size={11} />}
                {spec.enabled
                  ? [...spec.rules].sort((a, b) => a.offsetMin - b.offsetMin).map(r => offsetChip(r.offsetMin)).join(', ')
                  : 'No reminders'}
              </span>
            );
          })()}
          <span className="px-2 py-0.5 rounded-md bg-muted/20 border border-border/30 flex items-center gap-1">
            <Calendar size={11} /> {cat.defaultAllDay ? 'Defaults to All-Day' : 'Defaults to Timed'}
          </span>
          <span className="px-2 py-0.5 rounded-md bg-muted/20 border border-border/30 flex items-center gap-1">
            {cat.defaultNoCheckbox ? <Square size={11} /> : <CheckSquare size={11} />}
            {cat.defaultNoCheckbox ? 'Checkbox hidden' : 'Checkbox enabled'}
          </span>
          <span className="px-2 py-0.5 rounded-md bg-muted/20 border border-border/30 flex items-center gap-1">
            {cat.showInWidget !== false ? <Eye size={11} /> : <EyeOff size={11} />}
            {cat.showInWidget !== false ? 'Shown in Widget' : 'Hidden in Widget'}
          </span>
        </div>

        {previewStyle && (
          <div
            className="px-2.5 py-1 rounded-md text-[11px] font-semibold flex items-center gap-2 self-start sm:self-auto border transition-smooth"
            style={{
              backgroundColor: previewStyle.bg,
              borderColor: previewStyle.border,
              color: previewStyle.text,
              boxShadow: previewStyle.boxShadow,
            }}
          >
            {previewStyle.accentBar && (
              <span className="w-1.5 h-3 rounded-full" style={{ backgroundColor: previewStyle.accentBar }} />
            )}
            <span>Preview: {cat.name}</span>
          </div>
        )}
      </div>
    </Reorder.Item>
  );
}

function TaskListRow({
  list,
  darkMode,
  accentColor,
  cardBdr,
  textPrimary,
  textSecondary,
  isGeneral,
  deleteConfirmListId,
  isTouch,
  onPatch,
  onDelete,
  onSetDeleteConfirm,
}: {
  list: TaskList;
  darkMode: boolean;
  accentColor: string;
  cardBdr: string;
  textPrimary: string;
  textSecondary: string;
  isGeneral: boolean;
  deleteConfirmListId: string | null;
  isTouch: boolean;
  onPatch: (patch: Partial<TaskList>) => void;
  onDelete: () => void;
  onSetDeleteConfirm: (id: string | null) => void;
}) {
  const controls = useDragControls();

  return (
    <Reorder.Item
      value={list}
      id={list.id}
      dragListener={false}
      dragControls={controls}
      className="p-3.5 rounded-2xl border flex flex-col gap-3 group select-none relative"
      style={{
        background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.015)',
        borderColor: cardBdr,
      }}
      whileDrag={{
        scale: 1.02,
        boxShadow: `0 20px 40px -8px rgba(0,0,0,0.5), 0 0 0 2px ${accentColor}`,
        background: darkMode ? 'rgba(255,255,255,0.08)' : '#ffffff',
        zIndex: 50,
      }}
      transition={{ type: 'spring', stiffness: 500, damping: 40 }}
    >
      <div className="flex items-center gap-3">
        <div
          onPointerDown={e => {
            e.preventDefault();
            controls.start(e);
          }}
          className="cursor-grab active:cursor-grabbing p-1.5 -m-1.5 touch-none rounded-lg hover:bg-white/10 transition-colors flex items-center justify-center"
          title="Drag to reorder"
        >
          <GripVertical
            size={16}
            className="flex-shrink-0 opacity-70 sm:opacity-40 sm:group-hover:opacity-90 transition-opacity"
            style={{ color: textSecondary }}
          />
        </div>
        <div
          className="w-5 h-5 rounded-full flex-shrink-0 shadow-sm border"
          style={{ backgroundColor: list.color, borderColor: darkMode ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)' }}
        />
        <input
          value={list.name}
          onChange={e => onPatch({ name: e.target.value })}
          onBlur={e => { if (!e.target.value.trim()) onPatch({ name: 'Untitled list' }); }}
          maxLength={40}
          className="flex-1 min-w-0 px-3 py-2 rounded-xl border text-xs font-semibold outline-none transition-smooth"
          style={{
            background: darkMode ? 'rgba(255,255,255,0.06)' : '#ffffff',
            borderColor: cardBdr,
            color: textPrimary,
          }}
        />
        {isGeneral && (
          <span
            className="text-[10px] font-bold px-2 py-1 rounded-full flex-shrink-0"
            style={{ background: `${accentColor}18`, color: accentColor }}
            title="Every task that isn't filed anywhere else lives here, so this list can't be removed."
          >
            Default
          </span>
        )}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            type="button"
            onClick={() => onSetDeleteConfirm(list.id)}
            disabled={isGeneral}
            className="touch-target w-7 h-7 rounded-lg flex items-center justify-center border transition-smooth active:scale-95 disabled:opacity-30 disabled:pointer-events-none"
            style={{ borderColor: cardBdr, color: '#ef4444' }}
            title={isGeneral ? 'The default list cannot be deleted' : 'Delete list'}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap pl-7">
        {TASK_LIST_COLORS.map(hex => {
          const selected = list.color.toLowerCase() === hex.toLowerCase();
          return (
            <button
              key={hex}
              type="button"
              onClick={() => onPatch({ color: hex })}
              className={`${isTouch ? 'w-10 h-10' : 'w-6 h-6'} rounded-full flex items-center justify-center transition-smooth hover:scale-110 active:scale-95`}
              style={{ background: hex, border: `2px solid ${selected ? textPrimary : 'transparent'}` }}
              title={hex}
            >
              {selected && <CheckCircle2 size={12} color="#ffffff" />}
            </button>
          );
        })}
      </div>

      {deleteConfirmListId === list.id && (
        <div
          className="rounded-xl p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 border"
          style={{ background: 'rgba(239,68,68,0.08)', borderColor: 'rgba(239,68,68,0.35)' }}
        >
          <span className="text-[11px] font-medium" style={{ color: textPrimary }}>
            Delete “{list.name}”? Its tasks aren't deleted — they move back to General.
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={() => onSetDeleteConfirm(null)}
              className="touch-target px-3 h-8 rounded-lg text-[11px] font-semibold border"
              style={{ borderColor: cardBdr, color: textSecondary }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onDelete}
              className="touch-target px-3 h-8 rounded-lg text-[11px] font-bold text-white"
              style={{ background: '#ef4444' }}
            >
              Delete
            </button>
          </div>
        </div>
      )}
    </Reorder.Item>
  );
}

function TabPanel({ isPhone, children, className, ...rest }: HTMLMotionProps<'div'> & { isPhone: boolean }) {
  if (isPhone) return <div className={className}>{children as React.ReactNode}</div>;
  return <motion.div className={className} {...rest}>{children}</motion.div>;
}

export default function SettingsPage() {
  const [location, setLocation] = useLocation();
  const { user, logout } = useAuth();
  // Settings is a two-column layout with a 256px sidebar — on a phone that
  // leaves ~130px for the controls themselves, so the sidebar becomes a
  // horizontally scrolling strip of chips above the content instead.
  const vp = useViewport();
  const isPhone = vp.isPhone;
  // Hit-target sizing follows the pointer, not the width: a small tablet is
  // still fingers. Controls that stay their designed size but need a bigger
  // catchment carry index.css's `touch-target` instead, which only exists
  // inside a `pointer: coarse` media query — so a mouse never sees any of this.
  const isTouch = vp.isTouch;
  /**
   * index.css already pushes every text input to 16px on a coarse pointer, but
   * its `select` rule is a bare element selector and loses to Tailwind's
   * `.text-xs`. A <select> left at 12px makes iOS Safari zoom the whole page in
   * on focus and never zoom back out — so the size is restated inline, where
   * nothing can outrank it, along with a finger-sized row height.
   */
  const selectTouch: React.CSSProperties = isTouch ? { fontSize: 16, minHeight: 44 } : {};

  // Active Sidebar Tab
  // `?tab=integrations` deep-links a section — the header's "Google disconnected"
  // pill sends you straight to the connection controls rather than dumping you on
  // the appearance tab to go hunting.
  const [activeTab, setActiveTab] = useState<TabCategory>(() => {
    try {
      const requested = new URLSearchParams(window.location.search).get('tab');
      const known: string[] = ['appearance', 'calendar', 'categories', 'notifications', 'prayer', 'audio', 'shortcuts', 'backup', 'integrations', 'hardware', 'account'];
      if (requested && known.includes(requested)) return requested as TabCategory;
    } catch (_) {}
    return 'appearance';
  });

  const handleSelectTab = useCallback((tabId: TabCategory) => {
    haptic(6);
    setActiveTab(tabId);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('tab', tabId);
      window.history.replaceState(null, '', url.toString());
    } catch (_) {}
  }, []);

  useEffect(() => {
    try {
      const search = window.location.search || (location.includes('?') ? location.slice(location.indexOf('?')) : '');
      const requested = new URLSearchParams(search).get('tab');
      const known: string[] = ['appearance', 'calendar', 'categories', 'notifications', 'prayer', 'audio', 'shortcuts', 'backup', 'integrations', 'hardware', 'account'];
      if (requested && known.includes(requested)) {
        setActiveTab(requested as TabCategory);
      }
    } catch (_) {}
  }, [location]);

  useEffect(() => {
    const handlePopState = () => {
      try {
        const requested = new URLSearchParams(window.location.search).get('tab');
        const known: string[] = ['appearance', 'calendar', 'categories', 'notifications', 'prayer', 'audio', 'shortcuts', 'backup', 'integrations', 'hardware', 'account'];
        if (requested && known.includes(requested)) {
          setActiveTab(requested as TabCategory);
        }
      } catch (_) {}
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const mobileTabStripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!isPhone || !mobileTabStripRef.current) return;
    const activeBtn = mobileTabStripRef.current.querySelector<HTMLElement>('[data-active="true"]');
    if (activeBtn) {
      activeBtn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
    }
  }, [activeTab, isPhone]);

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
  const [customAnchor, setCustomAnchor] = useState<'day' | 'week'>(initialSettings.customAnchor ?? 'day');
  const [mobileSwipeViewSwitch, setMobileSwipeViewSwitch] = useState<boolean>(initialSettings.mobileSwipeViewSwitch ?? true);
  const [eventColorStyle, setEventColorStyle] = useState<EventCardStyle>(initialSettings.eventColorStyle);
  const [sidebarStyle, setSidebarStyle] = useState<SidebarStyle>(initialSettings.sidebarStyle);
  const [timeFormat, setTimeFormat] = useState<TimeFormat>(initialSettings.timeFormat);
  const [weekStartsOn, setWeekStartsOn] = useState<WeekStartsOn>(initialSettings.weekStartsOn);
  const [dayStartH, setDayStartH] = useState<number>(initialSettings.dayStartH);
  const [dayEndH, setDayEndH] = useState<number>(initialSettings.dayEndH);
  const [mobileContentZoom, setMobileContentZoom] = useState<number>(1);
  const [mobileUiZoom, setMobileUiZoom] = useState<number>(1);
  const [focusDayStartHour, setFocusDayStartHour] = useState<number>(initialSettings.focusDayStartHour);
  const [focusChime, setFocusChime] = useState<FocusChimeId>(initialSettings.focusChime);
  const [chimeCategory, setChimeCategory] = useState<'all' | FocusChimeCategory>('all');
  const [previewingChimeId, setPreviewingChimeId] = useState<string | null>(null);
  const [focusCues, setFocusCues] = useState<{ start: FocusCueId; pause: FocusCueId; resume: FocusCueId }>(initialSettings.focusCues);
  const [shortcuts, setShortcuts] = useState<ShortcutMap>(initialSettings.shortcuts);
  const [autoBackup, setAutoBackup] = useState<AutoBackupCfg>(initialSettings.autoBackup);
  // Tasks. `tasksPanelOpen`/`tasksPanelWidth`/`taskFilters` are owned by the main
  // window — carried here only so saving from this page never resets them.
  const [tasksPanelOpen, setTasksPanelOpen] = useState<boolean>(initialSettings.tasksPanelOpen);
  const [tasksPanelWidth, setTasksPanelWidth] = useState<number>(initialSettings.tasksPanelWidth);
  const [taskFilters, setTaskFilters] = useState<string[]>(initialSettings.taskFilters);
  const [autoRollRecurringTasks, setAutoRollRecurringTasks] = useState<boolean>(initialSettings.autoRollRecurringTasks ?? true);
  const [showTaskRow, setShowTaskRow] = useState<boolean>(initialSettings.showTaskRow);
  const [taskColor, setTaskColor] = useState<string>(initialSettings.taskColor);
  const [taskCheckboxShape, setTaskCheckboxShape] = useState<TaskCheckboxShape>(initialSettings.taskCheckboxShape ?? 'circle');
  const [googleSyncEnabled, setGoogleSyncEnabled] = useState<boolean>(initialSettings.googleSyncEnabled ?? false);
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
  const [notifications, setNotifications] = useState<NotificationSettings>(initialSettings.notifications);
  /** Patch one slice without disturbing the rest, exactly like patchPrayer. */
  const patchNotifications = useCallback((patch: Partial<NotificationSettings>) => {
    setNotifications(prev => ({ ...prev, ...patch }));
  }, []);
  // Used here only for this device's push state, the test buttons and the
  // health panel. The settings page never shows the banner itself.
  const notify = useNotifications({ soundEnabled: false, inAppEnabled: false });
  const [hardware, setHardware] = useState<HardwareSettings>(initialSettings.hardware);
  const [categories, setCategories] = useState<EventCategory[]>(initialSettings.categories ?? DEFAULT_CATEGORIES);
  const [taskLists, setTaskLists] = useState<TaskList[]>(() => coerceTaskLists(initialSettings.taskLists));
  const [editingCategory, setEditingCategory] = useState<EventCategory | null>(null);
  const [isAddingCategory, setIsAddingCategory] = useState<boolean>(false);
  const [categoryForm, setCategoryForm] = useState<{
    name: string;
    color: string;
    defaultDurationMin: number;
    defaultNoDuration: boolean;
    defaultAllDay: boolean;
    defaultNoCheckbox: boolean;
    showInWidget: boolean;
    isDefault: boolean;
    description: string;
    // `undefined` means this category inherits the global reminder defaults.
    notifyTimed: NotifySpec | undefined;
    notifyAllDay: NotifySpec | undefined;
  }>({
    name: '',
    color: '#22c55e',
    defaultDurationMin: 30,
    defaultNoDuration: false,
    defaultAllDay: false,
    defaultNoCheckbox: false,
    showInWidget: true,
    isDefault: false,
    description: '',
    notifyTimed: undefined,
    notifyAllDay: undefined,
  });
  const [deleteConfirmCatId, setDeleteConfirmCatId] = useState<string | null>(null);

  const openCreateCategory = () => {
    setEditingCategory(null);
    setCategoryForm({
      name: '',
      color: PRESET_CATEGORY_COLORS[categories.length % PRESET_CATEGORY_COLORS.length].hex,
      defaultDurationMin: 30,
      defaultNoDuration: false,
      defaultAllDay: false,
      defaultNoCheckbox: false,
      showInWidget: true,
      isDefault: false,
      description: '',
      notifyTimed: undefined,
      notifyAllDay: undefined,
    });
    setIsAddingCategory(true);
  };

  const openEditCategory = (cat: EventCategory) => {
    setIsAddingCategory(false);
    setEditingCategory(cat);
    const noDur = Boolean(cat.defaultNoDuration || cat.defaultDurationMin === 0);
    setCategoryForm({
      name: cat.name,
      color: cat.color,
      defaultDurationMin: noDur ? 0 : (cat.defaultDurationMin ?? 30),
      defaultNoDuration: noDur,
      defaultAllDay: cat.defaultAllDay ?? false,
      defaultNoCheckbox: cat.defaultNoCheckbox ?? false,
      showInWidget: cat.showInWidget ?? true,
      isDefault: cat.isDefault ?? false,
      description: cat.description ?? '',
      notifyTimed: cat.notifyTimed,
      notifyAllDay: cat.notifyAllDay,
    });
  };

  const closeCategoryModal = () => {
    const trimmedName = categoryForm.name.trim();
    if (trimmedName) {
      let color = categoryForm.color.trim();
      if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        color = '#22c55e';
      }

      if (isAddingCategory) {
        const newCat: EventCategory = {
          id: `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
          name: trimmedName,
          color,
          defaultDurationMin: categoryForm.defaultNoDuration ? 0 : categoryForm.defaultDurationMin,
          defaultNoDuration: categoryForm.defaultNoDuration,
          defaultAllDay: categoryForm.defaultAllDay,
          defaultNoCheckbox: categoryForm.defaultNoCheckbox,
          showInWidget: categoryForm.showInWidget,
          isDefault: categoryForm.isDefault,
          description: categoryForm.description.trim(),
          notifyTimed: categoryForm.notifyTimed,
          notifyAllDay: categoryForm.notifyAllDay,
        };

        setCategories(prev => {
          const list = categoryForm.isDefault ? prev.map(c => ({ ...c, isDefault: false })) : [...prev];
          return [...list, newCat];
        });
        showToast(`Category “${trimmedName}” saved.`, 'success');
      } else if (editingCategory) {
        setCategories(prev => {
          return prev.map(c => {
            if (c.id === editingCategory.id) {
              return {
                ...c,
                name: trimmedName,
                color,
                defaultDurationMin: categoryForm.defaultNoDuration ? 0 : categoryForm.defaultDurationMin,
                defaultNoDuration: categoryForm.defaultNoDuration,
                defaultAllDay: categoryForm.defaultAllDay,
                defaultNoCheckbox: categoryForm.defaultNoCheckbox,
                showInWidget: categoryForm.showInWidget,
                isDefault: categoryForm.isDefault,
                description: categoryForm.description.trim(),
                notifyTimed: categoryForm.notifyTimed,
                notifyAllDay: categoryForm.notifyAllDay,
              };
            }
            if (categoryForm.isDefault) {
              return { ...c, isDefault: false };
            }
            return c;
          });
        });
        showToast(`Category “${trimmedName}” updated.`, 'success');
      }
    }
    setEditingCategory(null);
    setIsAddingCategory(false);
  };

  const closeCategoryModalRef = useRef(closeCategoryModal);
  useEffect(() => {
    closeCategoryModalRef.current = closeCategoryModal;
  });

  const handleSaveCategory = () => {
    const trimmedName = categoryForm.name.trim();
    if (!trimmedName) {
      showToast('Category name cannot be empty.', 'error');
      return;
    }

    let color = categoryForm.color.trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      color = '#22c55e';
    }

    if (isAddingCategory) {
      const newCat: EventCategory = {
        id: `cat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: trimmedName,
        color,
        defaultDurationMin: categoryForm.defaultNoDuration ? 0 : categoryForm.defaultDurationMin,
        defaultNoDuration: categoryForm.defaultNoDuration,
        defaultAllDay: categoryForm.defaultAllDay,
        defaultNoCheckbox: categoryForm.defaultNoCheckbox,
        showInWidget: categoryForm.showInWidget,
        isDefault: categoryForm.isDefault,
        description: categoryForm.description.trim(),
        notifyTimed: categoryForm.notifyTimed,
        notifyAllDay: categoryForm.notifyAllDay,
      };

      setCategories(prev => {
        const list = categoryForm.isDefault ? prev.map(c => ({ ...c, isDefault: false })) : [...prev];
        return [...list, newCat];
      });
      showToast(`Category “${trimmedName}” created.`, 'success');
    } else if (editingCategory) {
      setCategories(prev => {
        return prev.map(c => {
          if (c.id === editingCategory.id) {
            return {
              ...c,
              name: trimmedName,
              color,
              defaultDurationMin: categoryForm.defaultNoDuration ? 0 : categoryForm.defaultDurationMin,
              defaultNoDuration: categoryForm.defaultNoDuration,
              defaultAllDay: categoryForm.defaultAllDay,
              defaultNoCheckbox: categoryForm.defaultNoCheckbox,
              showInWidget: categoryForm.showInWidget,
              isDefault: categoryForm.isDefault,
              description: categoryForm.description.trim(),
              notifyTimed: categoryForm.notifyTimed,
              notifyAllDay: categoryForm.notifyAllDay,
            };
          }
          if (categoryForm.isDefault) {
            return { ...c, isDefault: false };
          }
          return c;
        });
      });
      showToast(`Category “${trimmedName}” updated.`, 'success');
    }
    setEditingCategory(null);
    setIsAddingCategory(false);
  };

  const handleDeleteCategory = (id: string) => {
    if (categories.length <= 1) {
      showToast('You must keep at least one category.', 'error');
      setDeleteConfirmCatId(null);
      return;
    }
    const cat = categories.find(c => c.id === id);
    setCategories(prev => prev.filter(c => c.id !== id));
    setDeleteConfirmCatId(null);
    showToast(`Category “${cat?.name || 'Item'}” deleted.`, 'info');
  };

  const handleToggleDefaultCategory = (id: string) => {
    setCategories(prev => prev.map(c => ({
      ...c,
      isDefault: c.id === id ? !c.isDefault : false,
    })));
  };


  // ── Task lists ─────────────────────────────────────────────────────────────
  // The panel on the main window is where these are normally managed; this is
  // the same data, for when you're already in Settings. Deleting one here can't
  // rewrite the tasks that pointed at it (this window has no task store), so it
  // relies on `resolveListId` treating an unknown list as General — no task is
  // ever lost, it just comes home.
  const [deleteConfirmListId, setDeleteConfirmListId] = useState<string | null>(null);

  const handleAddTaskList = () => {
    const name = `List ${taskLists.length + 1}`;
    setTaskLists(prev => [...prev, { id: makeListId(name), name, color: nextListColor(prev) }]);
  };

  const patchTaskList = (id: string, patch: Partial<TaskList>) => {
    setTaskLists(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  };

  const handleDeleteTaskList = (id: string) => {
    if (id === GENERAL_LIST_ID) return;
    const list = taskLists.find(l => l.id === id);
    setTaskLists(prev => prev.filter(l => l.id !== id));
    setDeleteConfirmListId(null);
    showToast(`List “${list?.name || 'Untitled'}” deleted — its tasks moved to General.`, 'info');
  };

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

  const settingsLoaded = useRef(false);

  // ── This device's own settings ───────────────────────────────────────────
  // Mirrors home.tsx: the keys that describe THIS screen are read from and
  // written to the per-device store, never to the shared settings file.
  const sharedScopedRef = useRef<Pick<AppSettings, typeof DEVICE_SCOPED_KEYS[number]>>({
    calendarView: initialSettings.calendarView,
    customDaysBefore: initialSettings.customDaysBefore,
    customDaysAfter: initialSettings.customDaysAfter,
    customAnchor: initialSettings.customAnchor ?? 'day',
    mobileSwipeViewSwitch: initialSettings.mobileSwipeViewSwitch ?? true,
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
    if (d.customAnchor === 'day' || d.customAnchor === 'week') setCustomAnchor(d.customAnchor);
    if (typeof d.mobileSwipeViewSwitch === 'boolean') setMobileSwipeViewSwitch(d.mobileSwipeViewSwitch);
    setDayStartH(d.dayStartH);
    setDayEndH(d.dayEndH);
    setMobileContentZoom(d.mobileContentZoom ?? 1);
    setMobileUiZoom(d.mobileUiZoom ?? 1);
    setTasksPanelOpen(d.tasksPanelOpen);
    setTasksPanelWidth(d.tasksPanelWidth);
    setShowTaskRow(d.showTaskRow);
    setStickyAllDayMain(d.stickyAllDayMain);
    setStickyTasksMain(d.stickyTasksMain);
    deviceExtrasRef.current = {
      appZoom: d.appZoom, analysisTab: d.analysisTab, mobileTab: d.mobileTab,
      hiddenCategoryIds: d.hiddenCategoryIds ?? [],
      hiddenCategoriesByView: d.hiddenCategoriesByView ?? { day: [], week: [], month: [], year: [] },
    };
  }, []);
  /** Device-only values this page has no control for, carried through untouched. */
  const deviceExtrasRef = useRef<{
    appZoom: number;
    analysisTab: 'week' | 'month' | 'year';
    mobileTab: 'calendar' | 'tasks' | 'focus';
    hiddenCategoryIds: string[];
    hiddenCategoriesByView: Record<FilterViewKey, string[]>;
  }>({
    appZoom: 1,
    analysisTab: 'week',
    mobileTab: 'calendar',
    hiddenCategoryIds: [],
    hiddenCategoriesByView: { day: [], week: [], month: [], year: [] },
  });
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
      customDaysBefore, customDaysAfter, customAnchor, interval,
      mobileSwipeViewSwitch,
      tasksPanelOpen, tasksPanelWidth, showTaskRow,
      stickyAllDayMain, stickyTasksMain,
      darkMode, darkPreset, lightPreset,
      eventColorStyle, sidebarStyle,
      dayStartH, dayEndH,
      mobileContentZoom,
      mobileUiZoom,
      ...deviceExtrasRef.current,
    });
  }, [calendarView, customDaysBefore, customDaysAfter, customAnchor, interval, mobileSwipeViewSwitch, tasksPanelOpen,
      tasksPanelWidth, showTaskRow, stickyAllDayMain, stickyTasksMain, darkMode,
      darkPreset, lightPreset, eventColorStyle, sidebarStyle, dayStartH, dayEndH,
      mobileContentZoom, mobileUiZoom]);

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
      if (typeof s.autoRollRecurringTasks === 'boolean') setAutoRollRecurringTasks(s.autoRollRecurringTasks);
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
      setNotifications(s.notifications);
      setHardware(s.hardware);
      if (s.categories) setCategories(s.categories);
      if (s.taskLists) setTaskLists(coerceTaskLists(s.taskLists));
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
          if (typeof coerced.autoRollRecurringTasks === 'boolean') setAutoRollRecurringTasks(coerced.autoRollRecurringTasks);
          setTaskColor(coerced.taskColor);
          setTaskCheckboxShape(coerced.taskCheckboxShape);
          if (typeof coerced.googleSyncEnabled === 'boolean') setGoogleSyncEnabled(coerced.googleSyncEnabled);
          setGoogleTasksSync(coerced.googleTasksSync);
          if (typeof coerced.stickyAllDayWidget === 'boolean') setStickyAllDayWidget(coerced.stickyAllDayWidget);
          if (typeof coerced.stickyTasksWidget === 'boolean') setStickyTasksWidget(coerced.stickyTasksWidget);
          if (typeof coerced.gcalPushEnabled === 'boolean') setGcalPushEnabled(coerced.gcalPushEnabled);
          if (coerced.gcalPushTarget) setGcalPushTarget(coerced.gcalPushTarget);
          if (typeof coerced.gcalPushOtherCalendars === 'boolean') setGcalPushOtherCalendars(coerced.gcalPushOtherCalendars);
          if (typeof coerced.gcalPullDailyEdits === 'boolean') setGcalPullDailyEdits(coerced.gcalPullDailyEdits);
          if (typeof coerced.gcalPullDailyNew === 'boolean') setGcalPullDailyNew(coerced.gcalPullDailyNew);
          if (typeof coerced.gcalPullOtherCalendars === 'boolean') setGcalPullOtherCalendars(coerced.gcalPullOtherCalendars);
          if (typeof coerced.gcalMirrorLocalDeletions === 'boolean') setGcalMirrorLocalDeletions(coerced.gcalMirrorLocalDeletions);
          if (typeof coerced.gcalMirrorGoogleDeletions === 'boolean') setGcalMirrorGoogleDeletions(coerced.gcalMirrorGoogleDeletions);
          setPrayer(coerced.prayer);
          setNotifications(coerced.notifications);
          setHardware(coerced.hardware);
          if (coerced.categories) setCategories(coerced.categories);
          if (coerced.taskLists) setTaskLists(coerceTaskLists(coerced.taskLists));
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
      shortcutDefaultsVersion: SHORTCUT_DEFAULTS_VERSION,
      shortcuts,
      autoBackup,
      taskFilters,
      autoRollRecurringTasks,
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
      notifications,
      hardware,
      categories,
    taskLists,
    }), 150);
    return () => window.clearTimeout(broadcastId);
  }, [hardware, prayer, notifications, categories, taskLists, interval, darkMode, darkPreset, lightPreset, widgetDarkPreset, widgetLightPreset, calendarView, customDaysBefore, customDaysAfter, customAnchor, eventColorStyle, sidebarStyle, timeFormat, weekStartsOn, dayStartH, dayEndH, focusDayStartHour, focusChime, focusCues, shortcuts, autoBackup, tasksPanelOpen, tasksPanelWidth, taskFilters, autoRollRecurringTasks, showTaskRow, taskColor,
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
        if (closeCategoryModalRef.current) {
          closeCategoryModalRef.current();
        }
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
        showToast(`Full backup snapshot saved (${body.count} events bundled).`, 'success');
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
    customAnchor,
    eventColorStyle,
    sidebarStyle,
    timeFormat,
    weekStartsOn,
    dayStartH,
    dayEndH,
    focusDayStartHour,
    focusChime,
    focusCues,
    shortcutDefaultsVersion: SHORTCUT_DEFAULTS_VERSION,
    shortcuts,
    autoBackup,
    tasksPanelOpen,
    tasksPanelWidth,
    taskFilters,
    autoRollRecurringTasks,
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
    notifications,
    hardware,
    categories,
    taskLists,
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
    if (restored.customAnchor === 'day' || restored.customAnchor === 'week') setCustomAnchor(restored.customAnchor);
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
    if (restored.categories) setCategories(restored.categories);
    if (restored.taskLists) setTaskLists(coerceTaskLists(restored.taskLists));
    setAutoBackup(restored.autoBackup);
    setTasksPanelOpen(restored.tasksPanelOpen);
    setTasksPanelWidth(restored.tasksPanelWidth);
    setTaskFilters(restored.taskFilters);
    if (typeof restored.autoRollRecurringTasks === 'boolean') setAutoRollRecurringTasks(restored.autoRollRecurringTasks);
    setShowTaskRow(restored.showTaskRow);
    setTaskColor(restored.taskColor);
    if (restored.taskCheckboxShape) setTaskCheckboxShape(restored.taskCheckboxShape);
    setGoogleTasksSync(restored.googleTasksSync);
    setGoogleSyncEnabled(restored.googleSyncEnabled);
    setGcalPushEnabled(restored.gcalPushEnabled);
    setGcalPushTarget(restored.gcalPushTarget);
    setGcalPushOtherCalendars(restored.gcalPushOtherCalendars);
    setGcalPullDailyEdits(restored.gcalPullDailyEdits);
    setGcalPullDailyNew(restored.gcalPullDailyNew);
    setGcalPullOtherCalendars(restored.gcalPullOtherCalendars);
    setGcalMirrorLocalDeletions(restored.gcalMirrorLocalDeletions);
    setGcalMirrorGoogleDeletions(restored.gcalMirrorGoogleDeletions);
    setPrayer(restored.prayer);
    setNotifications(restored.notifications);
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
      downloadAnchor.setAttribute('download', `daily-planner-backup-${new Date().toISOString().split('T')[0]}.json`);
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

  // The reminder editor paints from this page's palette rather than carrying
  // its own, so it looks the same here as it does in the event menu.
  const notifyTheme: NotifyTheme = useMemo(() => ({
    darkMode,
    text: textPrimary,
    sub: textSecondary,
    bg: activeTheme.cardBg,
    bdr: cardBdr,
    surface: activeTheme.surfaceBg,
    hover: darkMode ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.04)',
    accent: accentColor,
  }), [darkMode, textPrimary, textSecondary, activeTheme.cardBg, activeTheme.surfaceBg, cardBdr, accentColor]);

  const tabs: { id: TabCategory; label: string; icon: React.ReactNode; badge?: string }[] = [
    { id: 'appearance', label: 'Appearance', icon: <Sun size={17} /> },
    { id: 'calendar', label: 'Calendar Grid', icon: <Calendar size={17} /> },
    { id: 'categories', label: 'Tasks & Categories', icon: <Tag size={17} />, badge: `${categories.length + taskLists.length}` },
    { id: 'notifications', label: 'Notifications', icon: <Bell size={17} />,
      badge: notifications.enabled ? undefined : 'Off' },
    { id: 'prayer', label: 'Prayer Times', icon: <Compass size={17} /> },
    { id: 'audio', label: 'Focus & Audio', icon: <Volume2 size={17} /> },
    { id: 'shortcuts', label: 'Shortcuts', icon: <Keyboard size={17} /> },
    { id: 'backup', label: 'Backups & Data', icon: <Database size={17} /> },
    { id: 'integrations', label: 'Integrations', icon: <Link2 size={17} />, badge: (googleSyncEnabled && gCalStatus.authenticated) ? 'Connected' : (!googleSyncEnabled ? 'Off' : undefined) },
    { id: 'hardware', label: 'Desk Controller', icon: <Cpu size={17} /> },
    { id: 'account', label: 'User Account', icon: <User size={17} /> },
  ];

  return (
    <MotionConfig reducedMotion={isPhone ? 'always' : 'never'}>
    <div
      // `100vh` is the URL-bar-hidden height, but this page lives inside App's
      // `fixed inset-0` scroller, which is the URL-bar-shown height — so on a
      // phone min-h-screen alone adds ~60px of empty scroll under the content.
      className={`${isPhone ? 'min-h-full' : 'min-h-screen'} flex flex-col font-sans transition-colors duration-300 relative ${
        darkMode ? 'dark text-[#f1f5f9]' : 'text-[#0f172a]'
      }`}
      style={{ backgroundColor: pageBg }}
    >
      {/* Outer side ambient canvas — see components/CanvasAmbient.tsx */}
      <CanvasAmbient style={sidebarStyle} dark={darkMode} lite={isPhone} />
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
            className={`flex items-center gap-2 rounded-xl text-xs font-semibold transition-smooth duration-200 hover:scale-[1.02] active:scale-[0.98] flex-shrink-0 ${isPhone ? 'w-10 h-10 justify-center' : 'px-3.5 py-2'}`}
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
            className={`flex items-center gap-2 rounded-xl text-xs font-medium transition-smooth ${isPhone ? 'w-10 h-10 justify-center' : 'px-3 py-1.5'}`}
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
      <div
        className={`flex-1 max-w-7xl w-full mx-auto ${isPhone ? 'flex flex-col px-3 pt-3 gap-4' : 'flex px-6 py-8 gap-8'}`}
        // The last control of the last section would otherwise sit under the
        // home bar, where it can be seen but never tapped.
        style={isPhone ? { paddingBottom: 'calc(2rem + var(--safe-bottom))' } : undefined}
      >
        {/* Category navigation. A vertical rail on a desktop; on a phone the
            same list turned on its side into a sticky, swipeable chip strip —
            no accordion, no hamburger, and the current section always visible. */}
        {isPhone ? (
          <div
            ref={mobileTabStripRef}
            className="sticky z-40 -mx-3 px-3 py-2 flex gap-1.5 overflow-x-auto no-scrollbar touch-scroll-x gpu-layer"
            // Must be the header's exact height (10 + 40 + 10 + 1px border): a
            // few pixels short and scrolling content shows through the seam.
            style={{ top: 'calc(61px + var(--safe-top))', background: headerBg }}
          >
            {tabs.map(tab => {
              const active = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  data-active={active ? 'true' : 'false'}
                  onClick={() => handleSelectTab(tab.id)}
                  className="flex items-center gap-1.5 px-3 h-10 rounded-xl text-[12px] font-bold whitespace-nowrap flex-shrink-0 active:scale-95 transition-transform"
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
                  onClick={() => handleSelectTab(tab.id)}
                  className="flex items-center justify-between px-3.5 py-3 rounded-2xl text-xs font-semibold transition-smooth duration-200 text-left"
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
          <AnimatePresence mode={isPhone ? 'sync' : 'wait'} initial={false}>
            {/* 🎨 APPEARANCE TAB */}
            {activeTab === 'appearance' && (
              <TabPanel
                isPhone={isPhone}
                key="appearance"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                {/* 📱 Mobile Page Sizing & Scale (Mobile view only) */}
                {isPhone && (
                  <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                    <div>
                      <div className="flex items-center gap-2">
                        <Smartphone size={18} style={{ color: accentColor }} />
                        <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                          Mobile Page Sizing & Scale
                        </h2>
                      </div>
                      <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                        Customize the scale of inner app content and outer UI elements separately for this phone.
                      </p>
                    </div>

                    {/* Option 1: Inner App Content Scale */}
                    <div className="p-3.5 sm:p-4 rounded-2xl border flex flex-col gap-3" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>
                            1. Inner Content Size (Items & Fonts)
                          </span>
                          <span className="text-[11px] block leading-snug" style={{ color: textSecondary }}>
                            Scales everything inside the app: event cards, times between items, fonts, timeline grids, and task lists.
                          </span>
                        </div>
                      </div>

                      {/* Stepper + Reset */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setMobileContentZoom(z => Math.max(0.5, Math.min(2.0, Math.round((z - 0.05) / 0.05) * 0.05)))}
                          disabled={mobileContentZoom <= 0.5 + 1e-9}
                          className="w-10 h-10 rounded-xl flex items-center justify-center border disabled:opacity-30 active:scale-95 transition-transform"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          title="Decrease content size"
                        >
                          <Minus size={16} />
                        </button>

                        <button
                          type="button"
                          onClick={() => setMobileContentZoom(1)}
                          className="flex-1 h-10 rounded-xl text-xs font-bold tabular-nums border flex items-center justify-center gap-1 active:scale-[0.98] transition-transform"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          title="Reset to 100%"
                        >
                          <span>{Math.round(mobileContentZoom * 100)}%</span>
                          {Math.abs(mobileContentZoom - 1) > 1e-6 && (
                            <span className="text-[10px] font-normal" style={{ color: textSecondary }}>(Reset)</span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => setMobileContentZoom(z => Math.max(0.5, Math.min(2.0, Math.round((z + 0.05) / 0.05) * 0.05)))}
                          disabled={mobileContentZoom >= 2.0 - 1e-9}
                          className="w-10 h-10 rounded-xl flex items-center justify-center border disabled:opacity-30 active:scale-95 transition-transform"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          title="Increase content size"
                        >
                          <Plus size={16} />
                        </button>
                      </div>

                      {/* Preset pills */}
                      <div className="grid grid-cols-4 gap-1.5 pt-1">
                        {[0.8, 0.9, 1.0, 1.15].map(preset => {
                          const active = Math.abs(mobileContentZoom - preset) < 0.02;
                          return (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setMobileContentZoom(preset)}
                              className="touch-target py-1.5 rounded-lg text-[11px] font-semibold border transition-smooth text-center"
                              style={{
                                background: active ? accentLight : cardBg,
                                borderColor: active ? accentColor : cardBdr,
                                color: active ? accentColor : textSecondary,
                              }}
                            >
                              {Math.round(preset * 100)}%
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Option 2: UI Wrapper Scale */}
                    <div className="p-3.5 sm:p-4 rounded-2xl border flex flex-col gap-3" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="text-xs font-semibold block" style={{ color: textPrimary }}>
                            2. UI Wrapper Size (Headers & Bottom Menu)
                          </span>
                          <span className="text-[11px] block leading-snug" style={{ color: textSecondary }}>
                            Scales the outer navigation wrapper: top headers, navigation buttons, and the bottom tab menu bar.
                          </span>
                        </div>
                      </div>

                      {/* Stepper + Reset */}
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setMobileUiZoom(z => Math.max(0.5, Math.min(2.0, Math.round((z - 0.05) / 0.05) * 0.05)))}
                          disabled={mobileUiZoom <= 0.5 + 1e-9}
                          className="w-10 h-10 rounded-xl flex items-center justify-center border disabled:opacity-30 active:scale-95 transition-transform"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          title="Decrease UI wrapper size"
                        >
                          <Minus size={16} />
                        </button>

                        <button
                          type="button"
                          onClick={() => setMobileUiZoom(1)}
                          className="flex-1 h-10 rounded-xl text-xs font-bold tabular-nums border flex items-center justify-center gap-1 active:scale-[0.98] transition-transform"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          title="Reset to 100%"
                        >
                          <span>{Math.round(mobileUiZoom * 100)}%</span>
                          {Math.abs(mobileUiZoom - 1) > 1e-6 && (
                            <span className="text-[10px] font-normal" style={{ color: textSecondary }}>(Reset)</span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => setMobileUiZoom(z => Math.max(0.5, Math.min(2.0, Math.round((z + 0.05) / 0.05) * 0.05)))}
                          disabled={mobileUiZoom >= 2.0 - 1e-9}
                          className="w-10 h-10 rounded-xl flex items-center justify-center border disabled:opacity-30 active:scale-95 transition-transform"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          title="Increase UI wrapper size"
                        >
                          <Plus size={16} />
                        </button>
                      </div>

                      {/* Preset pills */}
                      <div className="grid grid-cols-4 gap-1.5 pt-1">
                        {[0.8, 0.9, 1.0, 1.15].map(preset => {
                          const active = Math.abs(mobileUiZoom - preset) < 0.02;
                          return (
                            <button
                              key={preset}
                              type="button"
                              onClick={() => setMobileUiZoom(preset)}
                              className="touch-target py-1.5 rounded-lg text-[11px] font-semibold border transition-smooth text-center"
                              style={{
                                background: active ? accentLight : cardBg,
                                borderColor: active ? accentColor : cardBdr,
                                color: active ? accentColor : textSecondary,
                              }}
                            >
                              {Math.round(preset * 100)}%
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

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
                      className="touch-target relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer"
                      style={{
                        background: darkMode ? '#3b82f6' : 'rgba(0,0,0,0.15)',
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

                  {/* Universal Event Card Style Picker — each option renders a
                      real card through the same colour function the grid uses. */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Event Card Style (Applies to All Items & Google Calendar)
                    </span>
                    <span className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                      How every item on the grid is painted. The samples below are live — drawn
                      exactly the way the planner draws your events, in your current theme.
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { id: 'tinted',  label: 'Glass & Border Accent', desc: 'Muted fill in the event colour with a vivid border in the same hue. Default.' },
                        { id: 'solid',   label: 'Solid Smooth Fill',     desc: 'Filled block in the event colour; text flips to white or near-black for contrast.' },
                        { id: 'minimal', label: 'Minimal Left Accent',   desc: 'Plain white / dark-grey card. The colour appears only as a strip down the left edge.' },
                        { id: 'glowing', label: 'Luminous Neon Glow',    desc: 'Deep dim fill, bright border in the event colour, plus a soft glow cast around the card.' },
                      ].map(style => {
                        const selected = eventColorStyle === style.id;
                        return (
                          <button
                            key={style.id}
                            onClick={() => setEventColorStyle(style.id as any)}
                            className="p-3 rounded-2xl border text-left flex flex-col gap-2 transition-smooth cursor-pointer hover:scale-[1.01]"
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
                            {/* Live sample, on the real page background so the
                                contrast you see is the contrast you get. */}
                            <div className="rounded-xl p-2" style={{ background: pageBg }}>
                              <EventCardPreviewPair style={style.id as EventCardStyle} dark={darkMode} pageBg={pageBg} />
                            </div>
                            <span className="text-[10px] leading-snug" style={{ color: textSecondary }}>{style.desc}</span>
                          </button>
                        );
                      })}
                      </div>
                    </div>

                  {/* Canvas Ambient Background Picker — thumbnails render the same
                      ambient layers the real pages do (components/CanvasAmbient.tsx). */}
                  <div className="flex flex-col gap-3">
                    <span className="text-xs font-semibold" style={{ color: textPrimary }}>
                      Canvas Ambient Background Style
                    </span>
                    <span className="text-[11px] -mt-1.5" style={{ color: textSecondary }}>
                      The atmosphere behind the planner: a blue glow from the top-left, a green one
                      from the right, and a faint dot texture. It never touches your events — only
                      the empty space around the grid. Thumbnails are live, and boosted slightly so
                      the difference is visible at this size.
                    </span>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {[
                        { id: 'subtle-glow',       label: 'Subtle Ambient Glow',   desc: 'Soft corner glows plus the dot texture. Default.' },
                        { id: 'accent-aura',       label: 'Vivid Luminous Aura',   desc: 'The same two glows at roughly double strength — clearly coloured corners.' },
                        { id: 'minimal-flat',      label: 'Minimal Flat Canvas',   desc: 'Glows off, dots off. A completely flat, single-colour background.' },
                        { id: 'glass-translucent', label: 'Frosted Glass Surface', desc: 'Dimmed glows under a diagonal frost sheen, with a finer dot grain.' },
                      ].map(style => {
                        const selected = sidebarStyle === style.id;
                        return (
                          <button
                            key={style.id}
                            onClick={() => setSidebarStyle(style.id as SidebarStyle)}
                            className="p-3 rounded-2xl border text-left flex flex-col gap-2 transition-smooth cursor-pointer hover:scale-[1.01]"
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
                            <CanvasAmbientPreview style={style.id as SidebarStyle} dark={darkMode} pageBg={pageBg} />
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
                            className="flex items-center justify-between p-4 rounded-2xl border text-left transition-smooth"
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
              </TabPanel>
            )}

            {/* 📅 CALENDAR TAB */}
            {activeTab === 'calendar' && (
              <TabPanel
                isPhone={isPhone}
                key="calendar"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
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
                            className="py-3 rounded-xl text-xs font-semibold transition-smooth text-center"
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

                  {/* Custom View Basis */}
                  <div className="flex flex-col gap-3">
                    <div>
                      <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Custom View Basis</span>
                      <span className="text-[11px] block mt-0.5" style={{ color: textSecondary }}>
                        Choose how the Custom calendar view calculates its before & after day ranges.
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <button
                        onClick={() => setCustomAnchor('day')}
                        className="p-3.5 rounded-2xl border text-left transition-smooth flex flex-col gap-1.5"
                        style={{
                          background: customAnchor === 'day' ? accentLight : 'transparent',
                          borderColor: customAnchor === 'day' ? accentColor : cardBdr,
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-bold" style={{ color: customAnchor === 'day' ? accentColor : textPrimary }}>
                            Current Day (Today)
                          </span>
                          <span className="text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded" style={{ background: accentColor, color: '#fff' }}>Default</span>
                        </div>
                        <span className="text-[11px] leading-relaxed" style={{ color: textSecondary }}>
                          Before and After days are counted from today with positive increments (e.g. −2 / +2 days from Tuesday displays Sunday to Thursday).
                        </span>
                      </button>

                      <button
                        onClick={() => setCustomAnchor('week')}
                        className="p-3.5 rounded-2xl border text-left transition-smooth flex flex-col gap-1.5"
                        style={{
                          background: customAnchor === 'week' ? accentLight : 'transparent',
                          borderColor: customAnchor === 'week' ? accentColor : cardBdr,
                        }}
                      >
                        <span className="text-xs font-bold" style={{ color: customAnchor === 'week' ? accentColor : textPrimary }}>
                          Week Start & End
                        </span>
                        <span className="text-[11px] leading-relaxed" style={{ color: textSecondary }}>
                          Before is offset from week start, and After is offset from week end (allows negative and positive day shifts).
                        </span>
                      </button>
                    </div>
                  </div>

                  {/* Mobile Swipe View Switching */}
                  <div className="flex flex-col gap-2 pt-2 border-t" style={{ borderColor: cardBdr }}>
                    <label className="flex items-center justify-between gap-4 cursor-pointer">
                      <span className="flex flex-col">
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Mobile Horizontal Swipe Navigation</span>
                        <span className="text-[11px]" style={{ color: textSecondary }}>
                          Swipe left or right horizontally on mobile screens to toggle between Custom View and Month View.
                        </span>
                      </span>
                      <button
                        type="button"
                        onClick={() => setMobileSwipeViewSwitch(v => !v)}
                        className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: mobileSwipeViewSwitch ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={mobileSwipeViewSwitch}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth"
                          style={{ left: mobileSwipeViewSwitch ? 22 : 2 }}
                        />
                      </button>
                    </label>
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
                            className="p-3.5 rounded-2xl border text-center transition-smooth"
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
                            const duration = Math.max(1, dayEndH - dayStartH);
                            setDayStartH(newStart);
                            setDayEndH(newStart + duration);
                          }}
                          className="w-full py-2 px-3 text-xs font-semibold rounded-xl border outline-none transition-colors"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary, ...selectTouch }}
                        >
                          {Array.from({ length: 24 }, (_, i) => i).map(h => (
                            <option key={h} value={h}>{h === 0 ? '12:00 AM' : h < 12 ? `${h}:00 AM` : h === 12 ? '12:00 PM' : `${h - 12}:00 PM`}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-[11px] font-medium" style={{ color: textSecondary }}>Span Duration</label>
                        <select
                          value={Math.max(1, dayEndH - dayStartH)}
                          onChange={e => setDayEndH(dayStartH + parseInt(e.target.value))}
                          className="w-full py-2 px-3 text-xs font-semibold rounded-xl border outline-none transition-colors"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary, ...selectTouch }}
                        >
                          {Array.from({ length: 24 }, (_, i) => i + 1).map(d => (
                            <option key={d} value={d}>{d} {d === 1 ? 'Hour' : 'Hours'}{d === 24 ? ' (Full Day)' : ''}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <p className="text-[11px] px-1" style={{ color: textSecondary }}>
                      {(() => {
                        const formatH = (h: number) => {
                          const dh = h % 24;
                          if (dh === 0) return '12:00 AM';
                          if (dh === 12) return '12:00 PM';
                          return dh < 12 ? `${dh}:00 AM` : `${dh - 12}:00 PM`;
                        };
                        const span = Math.max(1, dayEndH - dayStartH);
                        return `Timeline: ${formatH(dayStartH)} – ${formatH(dayEndH)} (${span} hour${span === 1 ? '' : 's'} visible per day)`;
                      })()}
                    </p>
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
                        className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyAllDayMain ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyAllDayMain}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth"
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
                        className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyTasksMain ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyTasksMain}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth"
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
                        className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyAllDayWidget ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyAllDayWidget}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth"
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
                        className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                        style={{ background: stickyTasksWidget ? (darkMode ? '#38bdf8' : '#0284c7') : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                        aria-pressed={stickyTasksWidget}
                      >
                        <span
                          className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth"
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
                      className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                      style={{ background: showTaskRow ? taskColor : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={showTaskRow}
                    >
                      <span
                        className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth"
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
                        className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold transition-smooth"
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
                        className="flex items-center gap-1 px-3 py-1 rounded-lg text-xs font-semibold transition-smooth"
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
                          className={`${isTouch ? 'w-11 h-11' : 'w-8 h-8'} rounded-lg transition-transform hover:scale-110`}
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
                          className="touch-target w-6 h-6 bg-transparent border-0 cursor-pointer p-0"
                        />
                      </label>
                    </div>
                  </div>
                </div>
              </TabPanel>
            )}

            {/* 🏷️ ITEM CATEGORIES TAB */}
            {activeTab === 'categories' && (
              <TabPanel
                isPhone={isPhone}
                key="categories"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <Tag size={18} style={{ color: accentColor }} />
                        <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Item Categories</h2>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {categories.length} configured
                        </span>
                      </div>
                      <p className="text-xs mt-1" style={{ color: textSecondary }}>
                        Assign timed items and all-day events to specific categories with dedicated colors, default duration presets, and behavior settings.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={openCreateCategory}
                      className="touch-target px-4 h-9 rounded-xl text-xs font-bold text-white flex items-center justify-center gap-2 transition-smooth shadow-md active:scale-95 flex-shrink-0"
                      style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' }}
                    >
                      <Plus size={15} />
                      Add Category
                    </button>
                  </div>

                  {/* Categories Cards List — smooth Framer Motion drag to reorder */}
                  <Reorder.Group
                    axis="y"
                    values={categories}
                    onReorder={setCategories}
                    className="flex flex-col gap-3 select-none"
                  >
                    {categories.map((cat) => (
                      <CategoryRow
                        key={cat.id}
                        cat={cat}
                        darkMode={darkMode}
                        accentColor={accentColor}
                        cardBdr={cardBdr}
                        textPrimary={textPrimary}
                        textSecondary={textSecondary}
                        eventColorStyle={eventColorStyle}
                        activeTheme={activeTheme}
                        deleteConfirmCatId={deleteConfirmCatId}
                        onOpenEdit={() => openEditCategory(cat)}
                        onSetDefault={() => handleToggleDefaultCategory(cat.id)}
                        onSetDeleteConfirm={(id) => setDeleteConfirmCatId(id)}
                        onDelete={() => handleDeleteCategory(cat.id)}
                      />
                    ))}
                  </Reorder.Group>
                </div>

                {/* ── Task Lists ──────────────────────────────────────────── */}
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <FolderKanban size={18} style={{ color: accentColor }} />
                        <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Task Lists</h2>
                        <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
                          {taskLists.length} list{taskLists.length === 1 ? '' : 's'}
                        </span>
                      </div>
                      <p className="text-xs mt-1" style={{ color: textSecondary }}>
                        Separate boards inside the tasks panel — Work, Study, Errands. Not the same thing as
                        categories: a category colours a calendar item, a list decides which board a task sits on.
                        You can also manage these straight from the tasks panel on the main window.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={handleAddTaskList}
                      className="touch-target px-4 h-9 rounded-xl text-xs font-bold text-white flex items-center justify-center gap-2 transition-smooth shadow-md active:scale-95 flex-shrink-0"
                      style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' }}
                    >
                      <Plus size={15} />
                      Add List
                    </button>
                  </div>

                  {/* Task Lists — smooth Framer Motion drag to reorder */}
                  <Reorder.Group
                    axis="y"
                    values={taskLists}
                    onReorder={setTaskLists}
                    className="flex flex-col gap-3 select-none"
                  >
                    {taskLists.map((list) => (
                      <TaskListRow
                        key={list.id}
                        list={list}
                        darkMode={darkMode}
                        accentColor={accentColor}
                        cardBdr={cardBdr}
                        textPrimary={textPrimary}
                        textSecondary={textSecondary}
                        isGeneral={list.id === GENERAL_LIST_ID}
                        deleteConfirmListId={deleteConfirmListId}
                        isTouch={isTouch}
                        onPatch={(patch) => patchTaskList(list.id, patch)}
                        onDelete={() => handleDeleteTaskList(list.id)}
                        onSetDeleteConfirm={(id) => setDeleteConfirmListId(id)}
                      />
                    ))}
                  </Reorder.Group>
                </div>

                {/* ── Task Recurrence & Overdue Behavior ─────────────────── */}
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className="flex items-center gap-2">
                    <Repeat size={18} style={{ color: accentColor }} />
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Task Recurrence & Overdue Behavior</h2>
                  </div>
                  <p className="text-xs -mt-2" style={{ color: textSecondary }}>
                    Control how repeating tasks behave when scheduled occurrences are missed.
                  </p>

                  <div className="p-4 rounded-2xl border flex flex-col gap-3" style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.015)', borderColor: cardBdr }}>
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <span className="text-xs font-semibold block" style={{ color: textPrimary }}>
                          Roll Overdue Recurring Tasks to Today
                        </span>
                        <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>
                          When a recurring task reaches its next scheduled occurrence, remove older missed instances from Overdue and display the task only in Today.
                        </span>
                      </div>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={autoRollRecurringTasks}
                        onClick={() => setAutoRollRecurringTasks(v => !v)}
                        className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                        style={{ background: autoRollRecurringTasks ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                      >
                        <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: autoRollRecurringTasks ? 22 : 2 }} />
                      </button>
                    </div>

                    <div
                      className="rounded-xl p-3 text-[11px] leading-relaxed border"
                      style={{
                        background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                        borderColor: cardBdr,
                        color: textSecondary,
                      }}
                    >
                      <strong style={{ color: textPrimary }}>How this works: </strong>
                      If a task repeats daily and was missed yesterday, it stays in the Overdue section until today arrives. Once today arrives, it automatically clears from Overdue and appears as today's task. For tasks repeating every X days, missed tasks stay overdue until the next occurrence day arrives.
                    </div>
                  </div>
                </div>

                {/* Create / Edit Category Modal.

                    A centred card on a phone leaves its footer buttons under the
                    keyboard the moment the name field is focused, so on touch it
                    becomes a bottom sheet: anchored to the bottom, shortened by
                    whatever the keyboard is eating, scrolling inside itself, and
                    padded clear of the home bar. */}
                <AnimatePresence>
                  {(isAddingCategory || !!editingCategory) && (
                    <div
                      className={`fixed inset-0 z-50 flex justify-center bg-black/60 backdrop-blur-sm ${
                        isPhone ? 'items-end' : 'items-center p-4'
                      }`}
                      style={isPhone ? { height: `calc(100% - ${vp.keyboardInset}px)` } : undefined}
                      // Tapping/clicking outside dismisses and auto-saves the category
                      onPointerDown={e => { if (e.target === e.currentTarget) closeCategoryModal(); }}
                    >
                      <TabPanel
                        isPhone={isPhone}
                        initial={isPhone ? { opacity: 0, y: 30 } : { opacity: 0, scale: 0.95, y: 10 }}
                        animate={isPhone ? { opacity: 1, y: 0 } : { opacity: 1, scale: 1, y: 0 }}
                        exit={isPhone ? { opacity: 0, y: 30 } : { opacity: 0, scale: 0.95, y: 10 }}
                        transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
                        className={`w-full max-w-lg border shadow-2xl p-5 sm:p-6 flex flex-col gap-5 overflow-y-auto touch-scroll ${
                          isPhone ? 'rounded-t-3xl animate-sheet-up' : 'rounded-3xl max-h-[90vh] gpu-layer'
                        }`}
                        style={{
                          background: activeTheme.cardBg,
                          borderColor: cardBdr,
                          ...(isPhone ? {
                            maxHeight: '100%',
                            paddingBottom: 'calc(var(--safe-bottom) + 20px)',
                          } : {}),
                        }}
                      >
                        {/* Modal Header */}
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2.5">
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shadow-sm" style={{ backgroundColor: `${categoryForm.color}25`, color: categoryForm.color }}>
                              <Tag size={16} />
                            </div>
                            <div>
                              <h3 className="text-base font-bold" style={{ color: textPrimary }}>
                                {isAddingCategory ? 'New Category' : `Edit Category: ${editingCategory?.name}`}
                              </h3>
                              <p className="text-[11px]" style={{ color: textSecondary }}>
                                Configure category name, color, and default behavior
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={closeCategoryModal}
                            className="touch-target w-7 h-7 rounded-full flex items-center justify-center transition-colors hover:bg-white/10 flex-shrink-0"
                            style={{ color: textSecondary }}
                          >
                            <X size={16} />
                          </button>
                        </div>

                        {/* Name Input */}
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-semibold" style={{ color: textPrimary }}>Category Name *</label>
                          <input
                            type="text"
                            value={categoryForm.name}
                            onChange={e => setCategoryForm(prev => ({ ...prev, name: e.target.value }))}
                            placeholder="e.g. Personal, University Calender, Work, Fitness..."
                            className="w-full px-3.5 py-2.5 rounded-xl border text-xs outline-none transition-smooth"
                            style={{
                              background: darkMode ? 'rgba(255,255,255,0.06)' : '#ffffff',
                              borderColor: cardBdr,
                              color: textPrimary,
                            }}
                            // Autofocus on a phone opens the keyboard over the
                            // sheet before you have seen what is in it.
                            autoFocus={!isTouch}
                          />
                        </div>

                        {/* Description Input */}
                        <div className="flex flex-col gap-1.5">
                          <label className="text-xs font-semibold" style={{ color: textPrimary }}>Description (Optional)</label>
                          <input
                            type="text"
                            value={categoryForm.description}
                            onChange={e => setCategoryForm(prev => ({ ...prev, description: e.target.value }))}
                            placeholder="Short description or notes for this category"
                            className="w-full px-3.5 py-2 rounded-xl border text-xs outline-none transition-smooth"
                            style={{
                              background: darkMode ? 'rgba(255,255,255,0.06)' : '#ffffff',
                              borderColor: cardBdr,
                              color: textPrimary,
                            }}
                          />
                        </div>

                        {/* Color Picker Section */}
                        <div className="flex flex-col gap-2.5">
                          <label className="text-xs font-semibold" style={{ color: textPrimary }}>Category Color</label>
                          
                          {/* 12 Presets Grid */}
                          <div className="grid grid-cols-6 gap-2">
                            {PRESET_CATEGORY_COLORS.map(pc => {
                              const isSelected = categoryForm.color.toLowerCase() === pc.hex.toLowerCase();
                              return (
                                <button
                                  key={pc.hex}
                                  type="button"
                                  title={pc.label}
                                  onClick={() => setCategoryForm(prev => ({ ...prev, color: pc.hex }))}
                                  className={`${isTouch ? 'h-11' : 'h-8'} rounded-xl border flex items-center justify-center transition-transform hover:scale-105 active:scale-95`}
                                  style={{
                                    backgroundColor: pc.hex,
                                    borderColor: isSelected ? '#ffffff' : 'transparent',
                                    outline: isSelected ? `2px solid ${pc.hex}` : 'none',
                                    outlineOffset: 2,
                                  }}
                                >
                                  {isSelected && <Check size={14} className="text-white drop-shadow" />}
                                </button>
                              );
                            })}
                          </div>

                          {/* Custom Hex input */}
                          <div className="flex items-center gap-2 pt-1.5">
                            <input
                              type="color"
                              value={categoryForm.color}
                              onChange={e => setCategoryForm(prev => ({ ...prev, color: e.target.value }))}
                              className="touch-target w-8 h-8 rounded-lg cursor-pointer border-0 bg-transparent p-0 flex-shrink-0"
                              title="Pick custom RGB color"
                            />
                            <div className="flex items-center gap-1 flex-1 px-3 py-1.5 rounded-xl border" style={{ borderColor: cardBdr, background: darkMode ? 'rgba(255,255,255,0.06)' : '#ffffff' }}>
                              <span className="text-xs font-mono opacity-50" style={{ color: textSecondary }}>#</span>
                              <input
                                type="text"
                                value={categoryForm.color.replace(/^#/, '')}
                                onChange={e => {
                                  const val = e.target.value.trim().replace(/^#/, '');
                                  if (/^[0-9a-fA-F]{0,6}$/.test(val)) {
                                    setCategoryForm(prev => ({ ...prev, color: `#${val}` }));
                                  }
                                }}
                                placeholder="22c55e"
                                className="bg-transparent text-xs font-mono outline-none flex-1"
                                style={{ color: textPrimary }}
                              />
                            </div>
                          </div>
                        </div>

                        {/* Category Behavior Settings */}
                        <div className="flex flex-col gap-3.5 pt-2 border-t" style={{ borderColor: cardBdr }}>
                          <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: textSecondary }}>
                            Default Item Settings
                          </span>

                          {/* Default Duration — chips: None (10m space), 15m, 30m, 45m, 60m, 90m, 120m */}
                          <div className={`flex gap-3 ${isPhone ? 'flex-col' : 'items-center justify-between'}`}>
                            <div className="min-w-0">
                              <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Default Duration</span>
                              <span className="text-[11px]" style={{ color: textSecondary }}>
                                Pre-set duration when creating timed items in this category (or None for point-in-time deadlines)
                              </span>
                            </div>
                            <div className="flex items-center gap-1 bg-muted/20 p-1 rounded-xl border flex-wrap" style={{ borderColor: cardBdr }}>
                              <button
                                type="button"
                                onClick={() => setCategoryForm(prev => ({ ...prev, defaultNoDuration: true, defaultDurationMin: 0 }))}
                                className={`${isTouch ? 'px-3 py-2.5' : 'px-2 py-1'} rounded-lg text-[11px] font-bold transition-smooth ${
                                  categoryForm.defaultNoDuration ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                }`}
                              >
                                None (10m space)
                              </button>
                              {[15, 30, 45, 60, 90, 120].map(dur => (
                                <button
                                  key={dur}
                                  type="button"
                                  onClick={() => setCategoryForm(prev => ({ ...prev, defaultNoDuration: false, defaultDurationMin: dur }))}
                                  className={`${isTouch ? 'px-3 py-2.5' : 'px-2 py-1'} rounded-lg text-[11px] font-bold tabular-nums transition-smooth ${
                                    !categoryForm.defaultNoDuration && categoryForm.defaultDurationMin === dur ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                                  }`}
                                >
                                  {dur}m
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* No-Duration / Point-in-Time Toggle */}
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Point-in-Time / Deadline (No End Time)</span>
                              <span className="text-[11px]" style={{ color: textSecondary }}>
                                Items take a compact 10-minute slot on the calendar grid with start time only
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setCategoryForm(prev => ({
                                ...prev,
                                defaultNoDuration: !prev.defaultNoDuration,
                                defaultDurationMin: !prev.defaultNoDuration ? 0 : (prev.defaultDurationMin || 30),
                              }))}
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
                              style={{ background: categoryForm.defaultNoDuration ? categoryForm.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-smooth" style={{ left: categoryForm.defaultNoDuration ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* Default All-Day */}
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Default All-Day Event</span>
                              <span className="text-[11px]" style={{ color: textSecondary }}>Create items in this category as all-day events by default</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setCategoryForm(prev => ({ ...prev, defaultAllDay: !prev.defaultAllDay }))}
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
                              style={{ background: categoryForm.defaultAllDay ? categoryForm.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-smooth" style={{ left: categoryForm.defaultAllDay ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* Default No-Checkbox */}
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Completion Checkbox</span>
                              <span className="text-[11px]" style={{ color: textSecondary }}>Hide the completion tick box on items in this category</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setCategoryForm(prev => ({ ...prev, defaultNoCheckbox: !prev.defaultNoCheckbox }))}
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
                              style={{ background: categoryForm.defaultNoCheckbox ? categoryForm.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-smooth" style={{ left: categoryForm.defaultNoCheckbox ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* Show in Widget */}
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Show in Side Widget</span>
                              <span className="text-[11px]" style={{ color: textSecondary }}>Display events of this category in the desktop side widget</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setCategoryForm(prev => ({ ...prev, showInWidget: !prev.showInWidget }))}
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
                              style={{ background: categoryForm.showInWidget ? categoryForm.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-smooth" style={{ left: categoryForm.showInWidget ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* Set as Default Category for new items */}
                          <div className="flex items-center justify-between gap-3">
                            <div>
                              <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Set as Default Category</span>
                              <span className="text-[11px]" style={{ color: textSecondary }}>Automatically assign new items to this category</span>
                            </div>
                            <button
                              type="button"
                              onClick={() => setCategoryForm(prev => ({ ...prev, isDefault: !prev.isDefault }))}
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0"
                              style={{ background: categoryForm.isDefault ? '#10b981' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-smooth" style={{ left: categoryForm.isDefault ? 22 : 2 }} />
                            </button>
                          </div>
                        </div>

                        {/* Live Card Preview in Current Theme & Style */}
                        {(() => {
                          const previewChip = gcalChipColors(categoryForm.color, { dark: darkMode, style: eventColorStyle, pageBg: activeTheme.rootBg });
                          return (
                            <div className="p-3 rounded-2xl border flex flex-col gap-2" style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                              <span className="text-[10px] font-bold uppercase tracking-wider" style={{ color: textSecondary }}>
                                Live Preview ({eventColorStyle} style)
                              </span>
                              {previewChip && (
                                <div
                                  className="p-3 rounded-xl border relative flex flex-col gap-1 transition-smooth"
                                  style={{
                                    backgroundColor: previewChip.bg,
                                    borderColor: previewChip.border,
                                    color: previewChip.text,
                                    boxShadow: previewChip.boxShadow,
                                  }}
                                >
                                  {previewChip.accentBar && (
                                    <div className="absolute left-0 top-0 bottom-0 w-1.5 rounded-l-xl" style={{ backgroundColor: previewChip.accentBar }} />
                                  )}
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs font-bold truncate">
                                      {categoryForm.name.trim() || 'Category Preview'}
                                    </span>
                                    <span className="text-[10px] font-semibold tabular-nums" style={{ color: previewChip.textMuted }}>
                                      {categoryForm.defaultAllDay ? 'All Day' : categoryForm.defaultNoDuration ? '09:00 AM' : `09:00 AM (${categoryForm.defaultDurationMin}m)`}
                                    </span>
                                  </div>
                                  <span className="text-[10.5px] truncate" style={{ color: previewChip.textMuted }}>
                                    {categoryForm.description || 'Sample event card in this category'}
                                  </span>
                                </div>
                              )}
                            </div>
                          );
                        })()}

                        {/* Reminder defaults for this category. This is the
                            middle of the inheritance chain: an item in this
                            category with no reminders of its own takes these,
                            and these fall back to the global defaults. */}
                        <div className="flex flex-col gap-3 pt-3 border-t" style={{ borderColor: cardBdr }}>
                          <div>
                            <p className="text-[12px] font-bold flex items-center gap-1.5" style={{ color: textPrimary }}>
                              <Bell size={13} /> Reminders for this category
                            </p>
                            <p className="text-[10.5px] mt-0.5" style={{ color: textSecondary }}>
                              Anything in this category uses these unless it sets its own. Leave a section untouched to
                              keep following the global default under Notifications.
                            </p>
                          </div>

                          <CategoryNotifyBlock
                            label="Items with a time"
                            spec={categoryForm.notifyTimed}
                            fallback={notifications.defaultTimed}
                            kind="timed"
                            onChange={next => setCategoryForm(prev => ({ ...prev, notifyTimed: next }))}
                            theme={notifyTheme}
                            cardBdr={cardBdr}
                            textPrimary={textPrimary}
                            textSecondary={textSecondary}
                          />
                          <CategoryNotifyBlock
                            label="All-day items"
                            spec={categoryForm.notifyAllDay}
                            fallback={notifications.defaultAllDay}
                            kind="allDay"
                            onChange={next => setCategoryForm(prev => ({ ...prev, notifyAllDay: next }))}
                            theme={notifyTheme}
                            cardBdr={cardBdr}
                            textPrimary={textPrimary}
                            textSecondary={textSecondary}
                            hint={`Counted from ${String(notifications.allDayHour).padStart(2, '0')}:00 on the day, so "1 day before" lands at ${String(notifications.allDayHour).padStart(2, '0')}:00 the morning before.`}
                          />
                        </div>

                        {/* Modal Footer Buttons */}
                        <div className="flex items-center justify-end gap-2.5 pt-3 border-t" style={{ borderColor: cardBdr }}>
                          <button
                            type="button"
                            onClick={closeCategoryModal}
                            className="px-4 py-2 rounded-xl text-xs font-semibold border transition-colors hover:bg-white/5"
                            style={{ borderColor: cardBdr, color: textSecondary }}
                          >
                            {editingCategory ? 'Done / Close' : 'Cancel'}
                          </button>
                          <button
                            type="button"
                            onClick={handleSaveCategory}
                            className="px-5 py-2 rounded-xl text-xs font-bold text-white shadow-md transition-smooth active:scale-95 flex items-center gap-1.5"
                            style={{ background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' }}
                          >
                            <Check size={14} />
                            {isAddingCategory ? 'Create Category' : 'Save Changes'}
                          </button>
                        </div>
                      </TabPanel>
                    </div>
                  )}
                </AnimatePresence>
              </TabPanel>
            )}

            {/* 🔔 NOTIFICATIONS TAB */}
            {activeTab === 'notifications' && (
              <TabPanel
                isPhone={isPhone}
                key="notifications"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                {/* ── Master switch ───────────────────────────────────────── */}
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Notifications</h2>
                      <p className="text-xs mt-0.5 max-w-[60ch]" style={{ color: textSecondary }}>
                        Reminders are scheduled by the planner server, not by a browser tab, so they still fire when
                        every window is closed. They go out to this PC as a Windows notification and to every signed-up
                        phone or browser at the same time. Dealing with one anywhere clears it everywhere.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => patchNotifications({ enabled: !notifications.enabled })}
                      className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                      style={{ background: notifications.enabled ? accentColor : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={notifications.enabled}
                    >
                      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: notifications.enabled ? 22 : 2 }} />
                    </button>
                  </div>
                </div>

                {notifications.enabled && (
                  <>
                    {/* ── This device ──────────────────────────────────────── */}
                    <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-4" style={{ background: cardBg, borderColor: cardBdr }}>
                      <div>
                        <h3 className="text-sm font-bold tracking-tight flex items-center gap-2" style={{ color: textPrimary }}>
                          <MonitorSmartphone size={15} /> This device
                        </h3>
                        <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                          Each device signs itself up once. On a phone this is the important one: an installed app that
                          has signed up keeps receiving reminders even if you do not open it for days.
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold"
                          style={{
                            background: notify.pushState === 'subscribed' ? 'rgba(34,197,94,0.14)'
                              : notify.pushState === 'denied' || notify.pushState === 'error' ? 'rgba(239,68,68,0.14)'
                              : 'rgba(148,163,184,0.14)',
                            color: notify.pushState === 'subscribed' ? '#22c55e'
                              : notify.pushState === 'denied' || notify.pushState === 'error' ? '#ef4444'
                              : textSecondary,
                          }}
                        >
                          {notify.pushState === 'subscribed' ? <BellRing size={12} /> : <BellOff size={12} />}
                          {notify.pushState === 'subscribed' ? 'Signed up for notifications'
                            : notify.pushState === 'denied' ? 'Blocked in this browser'
                            : notify.pushState === 'unsupported' ? 'This browser cannot receive push'
                            : notify.pushState === 'subscribing' ? 'Signing up…'
                            : notify.pushState === 'error' ? 'Sign-up failed'
                            : 'Not signed up yet'}
                        </span>

                        {notify.pushState !== 'subscribed' && notify.pushState !== 'unsupported' && (
                          <button
                            type="button"
                            onClick={() => { primeNotificationAudio(); void notify.enablePush(); }}
                            className="rounded-lg px-3 py-1.5 text-[12px] font-semibold text-white transition-colors"
                            style={{ background: accentColor }}
                          >
                            Turn on for this device
                          </button>
                        )}
                        {notify.pushState === 'subscribed' && (
                          <button
                            type="button"
                            onClick={() => void notify.disablePush()}
                            className="rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
                            style={{ border: `1px solid ${cardBdr}`, color: textSecondary }}
                          >
                            Turn off here
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => { void notify.sendTest('normal'); showToast('Test notification sent to every signed-up device.', 'success'); }}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
                          style={{ border: `1px solid ${cardBdr}`, color: textPrimary }}
                        >
                          <Send size={12} /> Send a test
                        </button>
                        <button
                          type="button"
                          onClick={() => { void notify.sendTest('critical'); showToast('Critical test sent. It will repeat until you acknowledge it.', 'success'); }}
                          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-medium transition-colors"
                          style={{ border: '1px solid rgba(239,68,68,0.35)', color: '#ef4444' }}
                        >
                          <ShieldAlert size={12} /> Test a critical one
                        </button>
                      </div>

                      {notify.pushState === 'denied' && (
                        <p className="text-[11.5px] rounded-xl p-3" style={{ background: 'rgba(239,68,68,0.08)', color: '#f87171' }}>
                          This browser is blocking notifications, and only you can undo that: open the site settings for
                          this page (the icon next to the address, or the app's info screen) and set Notifications to Allow.
                        </p>
                      )}
                      {notify.pushError && (
                        <p className="text-[11.5px]" style={{ color: '#f87171' }}>{notify.pushError}</p>
                      )}

                      {/* The one piece of advice that actually matters on Android. */}
                      {!isInstalledApp() && (
                        <p className="text-[11.5px] rounded-xl p-3" style={{ background: accentLight, color: textSecondary }}>
                          On a phone, install this page as an app first (browser menu, then "Install app" or "Add to
                          Home screen"). An installed app gets its own icon in the notification shade and is allowed a
                          background wake-up, which is what lets it still alert you while this PC is asleep.
                        </p>
                      )}
                    </div>

                    {/* ── Delivery health ──────────────────────────────────── */}
                    <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-3" style={{ background: cardBg, borderColor: cardBdr }}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-sm font-bold tracking-tight flex items-center gap-2" style={{ color: textPrimary }}>
                            <Activity size={15} /> Delivery health
                          </h3>
                          <p className="text-xs mt-0.5 max-w-[60ch]" style={{ color: textSecondary }}>
                            A notification that silently fails to send is the one real danger here, so every channel
                            reports whether it last worked. Check this page if something ever feels quiet.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => void notify.refreshHealth()}
                          className="rounded-lg px-2.5 py-1 text-[11.5px] font-medium"
                          style={{ border: `1px solid ${cardBdr}`, color: textSecondary }}
                        >
                          Refresh
                        </button>
                      </div>

                      {notify.health ? (
                        <div className="flex flex-col gap-2">
                          <HealthRow
                            label="Scheduler"
                            ok={Date.now() - notify.health.lastTickAt < 90_000}
                            detail={notify.health.lastTickAt
                              ? `last checked ${new Date(notify.health.lastTickAt).toLocaleTimeString()}`
                              : 'has not run yet'}
                            textPrimary={textPrimary}
                            textSecondary={textSecondary}
                            cardBdr={cardBdr}
                          />
                          <HealthRow
                            label="Windows notifications"
                            ok={!notify.health.windowsToast.lastErrorAt
                              || (notify.health.windowsToast.lastOkAt ?? 0) > notify.health.windowsToast.lastErrorAt}
                            detail={notify.health.windowsToast.lastOkAt
                              ? `last shown ${new Date(notify.health.windowsToast.lastOkAt).toLocaleString()}`
                              : notify.health.windowsToast.lastError || 'nothing sent yet'}
                            textPrimary={textPrimary}
                            textSecondary={textSecondary}
                            cardBdr={cardBdr}
                          />
                          {notify.health.scheduledNext && (
                            <HealthRow
                              label="Next reminder"
                              ok
                              detail={`${notify.health.scheduledNext.title} — ${new Date(notify.health.scheduledNext.fireAt).toLocaleString()}`}
                              textPrimary={textPrimary}
                              textSecondary={textSecondary}
                              cardBdr={cardBdr}
                            />
                          )}

                          <p className="text-[10.5px] font-bold uppercase tracking-wider mt-1" style={{ color: textSecondary }}>
                            Signed-up devices ({notify.health.push.length})
                          </p>
                          {notify.health.push.length === 0 && (
                            <p className="text-[11.5px]" style={{ color: textSecondary }}>
                              No device has signed up yet. Nothing will reach your phone until one does.
                            </p>
                          )}
                          {notify.health.push.map(device => {
                            const healthy = !device.lastErrorAt || (device.lastOkAt ?? 0) > device.lastErrorAt;
                            return (
                              <div
                                key={device.id}
                                className="flex items-center gap-2 rounded-xl px-3 py-2"
                                style={{ border: `1px solid ${cardBdr}` }}
                              >
                                <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: healthy ? '#22c55e' : '#ef4444' }} />
                                <div className="min-w-0 flex-1">
                                  <p className="text-[12px] font-medium truncate" style={{ color: textPrimary }}>
                                    {device.label || 'Unnamed device'}
                                  </p>
                                  <p className="text-[10.5px] truncate" style={{ color: textSecondary }}>
                                    {healthy
                                      ? (device.lastOkAt ? `last delivered ${new Date(device.lastOkAt).toLocaleString()}` : 'signed up, nothing sent yet')
                                      : `failing: ${device.lastError ?? 'unknown error'}`}
                                  </p>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <p className="text-[11.5px]" style={{ color: textSecondary }}>Press Refresh to check.</p>
                      )}
                    </div>

                    {/* ── Defaults ─────────────────────────────────────────── */}
                    <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                      <div>
                        <h3 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Default reminders</h3>
                        <p className="text-xs mt-0.5 max-w-[60ch]" style={{ color: textSecondary }}>
                          What anything gets when it has no reminders of its own and its category has none either.
                          A category set up under Tasks &amp; Categories overrides these, and a single item overrides both.
                        </p>
                      </div>

                      <DefaultBlock
                        title="Items with a time"
                        hint="Counted from the item's start time."
                        theme={notifyTheme}
                        spec={notifications.defaultTimed}
                        kind="timed"
                        onChange={next => patchNotifications({ defaultTimed: next })}
                        cardBdr={cardBdr}
                        textPrimary={textPrimary}
                        textSecondary={textSecondary}
                      />

                      <DefaultBlock
                        title="All-day items"
                        hint={`An all-day item is treated as starting at ${String(notifications.allDayHour).padStart(2, '0')}:00, so "1 day before" means ${String(notifications.allDayHour).padStart(2, '0')}:00 the previous morning.`}
                        theme={notifyTheme}
                        spec={notifications.defaultAllDay}
                        kind="allDay"
                        onChange={next => patchNotifications({ defaultAllDay: next })}
                        cardBdr={cardBdr}
                        textPrimary={textPrimary}
                        textSecondary={textSecondary}
                        extra={(
                          <label className="flex items-center gap-2 text-[11.5px]" style={{ color: textSecondary }}>
                            All-day items count from
                            <select
                              value={notifications.allDayHour}
                              onChange={e => patchNotifications({ allDayHour: Number(e.target.value) })}
                              className="rounded-lg px-2 py-1 text-[12px] outline-none"
                              style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                            >
                              {Array.from({ length: 24 }, (_, h) => (
                                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                              ))}
                            </select>
                          </label>
                        )}
                      />

                      <DefaultBlock
                        title="Tasks"
                        hint="A task with a time is reminded like an event. A task with only a date is not reminded on its own: whatever is still open that day arrives as one summary at the cutoff."
                        theme={notifyTheme}
                        spec={notifications.defaultTask}
                        kind="task"
                        onChange={next => patchNotifications({ defaultTask: next })}
                        cardBdr={cardBdr}
                        textPrimary={textPrimary}
                        textSecondary={textSecondary}
                        extra={(
                          <label className="flex items-center gap-2 text-[11.5px]" style={{ color: textSecondary }}>
                            Daily summary of what is still open at
                            <select
                              value={notifications.taskCutoffHour}
                              onChange={e => patchNotifications({ taskCutoffHour: Number(e.target.value) })}
                              className="rounded-lg px-2 py-1 text-[12px] outline-none"
                              style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                            >
                              {Array.from({ length: 24 }, (_, h) => (
                                <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>
                              ))}
                            </select>
                          </label>
                        )}
                      />

                      <DefaultBlock
                        title="Prayer times"
                        hint="Off by default. A prayer already marked done is never reminded about."
                        theme={notifyTheme}
                        spec={notifications.prayer}
                        kind="timed"
                        onChange={next => patchNotifications({ prayer: next })}
                        cardBdr={cardBdr}
                        textPrimary={textPrimary}
                        textSecondary={textSecondary}
                      />
                    </div>

                    {/* ── How they arrive ──────────────────────────────────── */}
                    <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-3" style={{ background: cardBg, borderColor: cardBdr }}>
                      <h3 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>How they arrive</h3>
                      <p className="text-xs" style={{ color: textSecondary }}>
                        Each channel is independent. Leaving them all on is the point: if one fails, the others still get through.
                      </p>

                      <ToggleRow
                        label="Windows notifications"
                        hint="A real Windows notification from the planner server, with working buttons, even with every window closed."
                        value={notifications.windowsToast}
                        onChange={v => patchNotifications({ windowsToast: v })}
                        accentColor={accentColor} darkMode={darkMode} cardBdr={cardBdr}
                        textPrimary={textPrimary} textSecondary={textSecondary}
                      />
                      <ToggleRow
                        label="Phone and browser push"
                        hint="Sent to every signed-up device over its own always-on channel."
                        value={notifications.webPush}
                        onChange={v => patchNotifications({ webPush: v })}
                        accentColor={accentColor} darkMode={darkMode} cardBdr={cardBdr}
                        textPrimary={textPrimary} textSecondary={textSecondary}
                      />
                      <ToggleRow
                        label="Also push to this PC's browsers"
                        hint="Off keeps one reminder per screen here: the Windows notification only. Turn on if the Windows ones ever stop arriving."
                        value={notifications.desktopPush}
                        onChange={v => patchNotifications({ desktopPush: v })}
                        accentColor={accentColor} darkMode={darkMode} cardBdr={cardBdr}
                        textPrimary={textPrimary} textSecondary={textSecondary}
                      />
                      <ToggleRow
                        label="Banner inside the planner"
                        hint="What you see when you already have the planner open."
                        value={notifications.inApp}
                        onChange={v => patchNotifications({ inApp: v })}
                        accentColor={accentColor} darkMode={darkMode} cardBdr={cardBdr}
                        textPrimary={textPrimary} textSecondary={textSecondary}
                      />
                      <ToggleRow
                        label="Sound"
                        hint="Plays in open planner windows. A critical reminder always sounds, whatever this says."
                        value={notifications.sound}
                        onChange={v => patchNotifications({ sound: v })}
                        accentColor={accentColor} darkMode={darkMode} cardBdr={cardBdr}
                        textPrimary={textPrimary} textSecondary={textSecondary}
                      />
                    </div>

                    {/* ── Behaviour ────────────────────────────────────────── */}
                    <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-4" style={{ background: cardBg, borderColor: cardBdr }}>
                      <h3 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>Behaviour</h3>

                      <div className="flex flex-col gap-1.5">
                        <span className="text-[11.5px] font-semibold flex items-center gap-1.5" style={{ color: textPrimary }}>
                          <AlarmClock size={13} /> Snooze buttons
                        </span>
                        <p className="text-[11px]" style={{ color: textSecondary }}>
                          Offered on the notification itself. Snoozing on one device snoozes it everywhere.
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-0.5">
                          {[5, 10, 15, 20, 30, 45, 60, 120].map(m => {
                            const on = notifications.snoozeOptions.includes(m);
                            return (
                              <button
                                key={m}
                                type="button"
                                onClick={() => {
                                  const next = on
                                    ? notifications.snoozeOptions.filter(v => v !== m)
                                    : [...notifications.snoozeOptions, m].sort((a, b) => a - b).slice(0, 5);
                                  if (!next.length) return; // there must always be one
                                  patchNotifications({ snoozeOptions: next });
                                }}
                                className="rounded-lg px-2.5 py-1 text-[11.5px] font-medium transition-colors"
                                style={{
                                  background: on ? accentLight : 'transparent',
                                  border: `1px solid ${on ? accentColor : cardBdr}`,
                                  color: on ? accentColor : textSecondary,
                                }}
                              >
                                {m < 60 ? `${m} min` : `${m / 60} hr`}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 pt-2" style={{ borderTop: `1px solid ${cardBdr}` }}>
                        <span className="text-[11.5px] font-semibold flex items-center gap-1.5" style={{ color: textPrimary }}>
                          <ShieldAlert size={13} /> Critical reminders
                        </span>
                        <p className="text-[11px]" style={{ color: textSecondary }}>
                          A reminder marked critical keeps going until you acknowledge it on any device.
                        </p>
                        <div className="flex flex-wrap items-center gap-2 pt-0.5 text-[11.5px]" style={{ color: textSecondary }}>
                          Repeat every
                          <NumberField
                            value={notifications.escalateEveryMin}
                            onCommit={n => patchNotifications({ escalateEveryMin: n })}
                            min={1} max={60}
                            className="w-16 rounded-lg px-2 py-1 text-[12px] outline-none"
                            style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                            ariaLabel="Minutes between repeats"
                          />
                          minutes, up to
                          <NumberField
                            value={notifications.escalateTimes}
                            onCommit={n => patchNotifications({ escalateTimes: n })}
                            min={0} max={60}
                            className="w-16 rounded-lg px-2 py-1 text-[12px] outline-none"
                            style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                            ariaLabel="Maximum repeats"
                          />
                          times
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 pt-2" style={{ borderTop: `1px solid ${cardBdr}` }}>
                        <span className="text-[11.5px] font-semibold flex items-center gap-1.5" style={{ color: textPrimary }}>
                          <Bell size={13} /> After the PC has been off
                        </span>
                        <p className="text-[11px]" style={{ color: textSecondary }}>
                          Anything missed while this machine was asleep is delivered when it wakes, as long as it is no
                          older than this. Older ones are still listed in the notification centre, marked as missed,
                          rather than arriving as a pile of stale alerts.
                        </p>
                        <div className="flex items-center gap-2 pt-0.5 text-[11.5px]" style={{ color: textSecondary }}>
                          Deliver anything missed in the last
                          <NumberField
                            value={notifications.catchUpHours}
                            onCommit={n => patchNotifications({ catchUpHours: n })}
                            min={0} max={72}
                            className="w-16 rounded-lg px-2 py-1 text-[12px] outline-none"
                            style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                            ariaLabel="Catch-up window in hours"
                          />
                          hours
                        </div>
                      </div>

                      <div className="flex flex-col gap-1.5 pt-2" style={{ borderTop: `1px solid ${cardBdr}` }}>
                        <ToggleRow
                          label="Quiet hours"
                          hint="Ordinary reminders are held back and released when the window ends. Critical ones ignore it completely."
                          value={notifications.quietHoursEnabled}
                          onChange={v => patchNotifications({ quietHoursEnabled: v })}
                          accentColor={accentColor} darkMode={darkMode} cardBdr={cardBdr}
                          textPrimary={textPrimary} textSecondary={textSecondary}
                          noBorder
                        />
                        {notifications.quietHoursEnabled && (
                          <div className="flex items-center gap-2 text-[11.5px]" style={{ color: textSecondary }}>
                            From
                            <select
                              value={notifications.quietFromH}
                              onChange={e => patchNotifications({ quietFromH: Number(e.target.value) })}
                              className="rounded-lg px-2 py-1 text-[12px] outline-none"
                              style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                            >
                              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                            </select>
                            to
                            <select
                              value={notifications.quietToH}
                              onChange={e => patchNotifications({ quietToH: Number(e.target.value) })}
                              className="rounded-lg px-2 py-1 text-[12px] outline-none"
                              style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                            >
                              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                            </select>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-2 pt-2 text-[11.5px]" style={{ borderTop: `1px solid ${cardBdr}`, color: textSecondary }}>
                        Keep the last
                        <NumberField
                          value={notifications.historyLimit}
                          onCommit={n => patchNotifications({ historyLimit: n })}
                          min={20} max={2000}
                          className="w-20 rounded-lg px-2 py-1 text-[12px] outline-none"
                          style={{ background: activeTheme.surfaceBg, border: `1px solid ${cardBdr}`, color: textPrimary }}
                          ariaLabel="How many notifications to keep"
                        />
                        notifications in the notification centre
                      </div>
                    </div>
                  </>
                )}
              </TabPanel>
            )}

            {/* 🕌 PRAYER TIMES TAB */}
            {activeTab === 'prayer' && (
              <TabPanel
                isPhone={isPhone}
                key="prayer"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
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
                      className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                      style={{ background: prayer.enabled ? prayer.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={prayer.enabled}
                      title={prayer.enabled ? 'Prayer times are shown' : 'Prayer times are hidden'}
                    >
                      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: prayer.enabled ? 22 : 2 }} />
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
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary, ...selectTouch }}
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
                              className="touch-target px-3 py-1 rounded-lg text-xs font-semibold transition-smooth"
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
                                className="touch-target px-3 py-1.5 rounded-xl text-xs font-semibold border transition-smooth"
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
                              className="p-3 rounded-2xl border text-left flex flex-col gap-1 transition-smooth"
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
                              className={`${isTouch ? 'w-11 h-11' : 'w-8 h-8'} rounded-lg transition-transform hover:scale-110`}
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
                              className="touch-target w-6 h-6 bg-transparent border-0 cursor-pointer p-0"
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
                          className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                          style={{ background: prayer.showInWidget ? prayer.color : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                          aria-pressed={prayer.showInWidget}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: prayer.showInWidget ? 22 : 2 }} />
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
              </TabPanel>
            )}

            {/* ⏱️ AUDIO TAB */}
            {activeTab === 'audio' && (
              <TabPanel
                isPhone={isPhone}
                key="audio"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className={`flex gap-3 ${isPhone ? 'flex-col items-start' : 'items-center justify-between'}`}>
                    <div className="min-w-0">
                      <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                        Focus Audio & Chimes
                      </h2>
                      <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                        Preview and select soothing WebAudio synthesizers for timer events.
                      </p>
                    </div>

                    <button
                      onClick={() => {
                        setFocusChime(DEFAULT_FOCUS_CHIME);
                        setFocusCues({ ...DEFAULT_FOCUS_CUES });
                      }}
                      className="touch-target flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-smooth flex-shrink-0"
                      style={{ background: cardBg, borderColor: cardBdr, color: textSecondary }}
                    >
                      <RotateCcw size={14} />
                      <span>Reset Defaults</span>
                    </button>
                  </div>

                  {/* Chime picker */}
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                      <div>
                        <span className="text-xs font-semibold" style={{ color: textPrimary }}>Session-Complete Sound Chime</span>
                        <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                          Procedurally synthesized WebAudio soundscapes — zero lag, zero files to download.
                        </p>
                      </div>

                      {/* Category Filter Pills */}
                      <div className="flex flex-wrap items-center gap-1.5 p-1 rounded-xl border" style={{ background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                        {([
                          { id: 'all', label: 'All', count: FOCUS_CHIMES.length },
                          { id: 'meditative', label: 'Meditative', count: FOCUS_CHIMES.filter(c => c.category === 'meditative').length },
                          { id: 'acoustic', label: 'Acoustic', count: FOCUS_CHIMES.filter(c => c.category === 'acoustic').length },
                          { id: 'celestial', label: 'Celestial', count: FOCUS_CHIMES.filter(c => c.category === 'celestial').length },
                          { id: 'ambient', label: 'Ambient', count: FOCUS_CHIMES.filter(c => c.category === 'ambient').length },
                        ] as { id: 'all' | FocusChimeCategory; label: string; count: number }[]).map(cat => {
                          const active = chimeCategory === cat.id;
                          return (
                            <button
                              key={cat.id}
                              type="button"
                              onClick={() => setChimeCategory(cat.id)}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold transition-all duration-150 flex items-center gap-1"
                              style={{
                                background: active ? (darkMode ? 'rgba(255,255,255,0.12)' : '#ffffff') : 'transparent',
                                color: active ? textPrimary : textSecondary,
                                boxShadow: active ? '0 1px 3px rgba(0,0,0,0.12)' : 'none',
                              }}
                            >
                              <span>{cat.label}</span>
                              <span className="text-[9.5px] opacity-60 font-mono">({cat.count})</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-col gap-2.5">
                      {FOCUS_CHIMES
                        .filter(c => chimeCategory === 'all' || c.category === chimeCategory)
                        .map(c => {
                          const active = focusChime === c.id;
                          const isPreviewing = previewingChimeId === c.id;
                          return (
                            <div
                              key={c.id}
                              className="flex items-center justify-between p-3.5 rounded-2xl border transition-smooth"
                              style={{
                                background: active ? accentLight : 'transparent',
                                borderColor: active ? accentColor : cardBdr,
                              }}
                            >
                              <div className="flex items-center gap-3 min-w-0 pr-2">
                                <button
                                  type="button"
                                  onClick={() => {
                                    setPreviewingChimeId(c.id);
                                    playFocusChime(c.id);
                                    setTimeout(() => setPreviewingChimeId(prev => prev === c.id ? null : prev), 1800);
                                  }}
                                  className={`touch-target p-2.5 rounded-xl border transition-all duration-200 flex-shrink-0 ${
                                    isPreviewing ? 'scale-110 ring-2 ring-blue-400 ring-offset-1' : 'hover:scale-105'
                                  }`}
                                  style={{
                                    background: isPreviewing ? accentColor : cardBg,
                                    borderColor: cardBdr,
                                    color: isPreviewing ? '#ffffff' : accentColor,
                                  }}
                                  title="Click to preview chime"
                                >
                                  <Volume2 size={16} className={isPreviewing ? 'animate-pulse' : ''} />
                                </button>
                                <div className="min-w-0">
                                  <div className="flex items-center gap-2 flex-wrap">
                                    <span className="text-xs font-bold" style={{ color: active ? accentColor : textPrimary }}>
                                      {c.label}
                                    </span>
                                    <span
                                      className="text-[9.5px] font-semibold px-2 py-0.5 rounded-md uppercase tracking-wider"
                                      style={{
                                        background: darkMode ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
                                        color: textSecondary,
                                      }}
                                    >
                                      {c.category}
                                    </span>
                                  </div>
                                  <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>
                                    {c.hint}
                                  </span>
                                </div>
                              </div>

                              <button
                                type="button"
                                onClick={() => {
                                  setFocusChime(c.id);
                                  setPreviewingChimeId(c.id);
                                  playFocusChime(c.id);
                                  setTimeout(() => setPreviewingChimeId(prev => prev === c.id ? null : prev), 1800);
                                }}
                                className="touch-target px-4 py-2 rounded-xl text-xs font-semibold transition-smooth flex-shrink-0"
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
                                className="touch-target px-3 py-1.5 rounded-xl text-xs font-semibold transition-smooth"
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
              </TabPanel>
            )}

            {/* ⌨️ SHORTCUTS TAB */}
            {activeTab === 'shortcuts' && (
              <TabPanel
                isPhone={isPhone}
                key="shortcuts"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div className={`flex gap-3 ${isPhone ? 'flex-col items-start' : 'items-center justify-between'}`}>
                    <div className="min-w-0">
                      <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                        Keyboard Shortcuts
                      </h2>
                      <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                        Click any shortcut box, then press your desired key combination to rebind it.
                      </p>
                    </div>

                    <button
                      onClick={() => setShortcuts({ ...DEFAULT_SHORTCUTS })}
                      className="touch-target flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-smooth flex-shrink-0"
                      style={{ background: cardBg, borderColor: cardBdr, color: textSecondary }}
                    >
                      <RotateCcw size={14} />
                      <span>Reset Defaults</span>
                    </button>
                  </div>

                  <div
                    className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border px-3.5 py-3"
                    style={{ background: darkMode ? 'rgba(59,130,246,0.08)' : 'rgba(59,130,246,0.06)', borderColor: accentColor }}
                  >
                    <div>
                      <p className="text-xs font-semibold" style={{ color: textPrimary }}>Focus timer default</p>
                      <p className="mt-0.5 text-[10px]" style={{ color: textSecondary }}>
                        Assigns Start / pause timer without relying on the browser capturing the Windows key.
                      </p>
                    </div>
                    <button
                      onClick={() => {
                        setShortcuts(prev => ({ ...prev, toggleTimer: FOCUS_TIMER_TOGGLE_DEFAULT }));
                        setRecordingAction(null);
                        showToast(`Start / pause timer is set to ${formatCombo(FOCUS_TIMER_TOGGLE_DEFAULT)}.`, 'success');
                      }}
                      className="touch-target flex items-center gap-1.5 rounded-xl border px-3 py-1.5 text-xs font-semibold transition-smooth"
                      style={{ background: accentColor, borderColor: accentColor, color: '#ffffff' }}
                      title="Set Start / pause timer to Win + Shift + F1"
                    >
                      Use {formatCombo(FOCUS_TIMER_TOGGLE_DEFAULT)}
                    </button>
                  </div>

                  {/* Rebinding needs keys to press. A phone has none, so the
                      boxes below can be read but never changed — say so rather
                      than leaving taps that appear to do nothing. */}
                  {isTouch && (
                    <p
                      className="text-[11px] leading-snug p-3 rounded-xl border"
                      style={{ color: textSecondary, borderColor: cardBdr, background: darkMode ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.02)' }}
                    >
                      These are shown for reference only on a touch device — rebinding needs a physical
                      keyboard. Open Settings on the PC to change them; the bindings are shared.
                    </p>
                  )}

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
                              disabled={isTouch}
                              onClick={e => {
                                if (isTouch || e.detail === 0) return;
                                setRecordingAction(recording ? null : def.action);
                              }}
                              className={`flex items-center justify-between p-3.5 rounded-2xl border text-left transition-smooth ${isTouch ? 'cursor-default' : 'cursor-pointer'}`}
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
              </TabPanel>
            )}

            {/* 💾 BACKUP TAB */}
            {activeTab === 'backup' && (
              <TabPanel
                isPhone={isPhone}
                key="backup"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
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
                        className="touch-target relative w-11 h-6 rounded-full transition-colors duration-200 flex-shrink-0 cursor-pointer"
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
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary, opacity: autoBackup.enabled ? 1 : 0.4, ...selectTouch }}
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
                        {backupStatus ? `${backupStatus.count} backups stored in database/users/${user?.username || 'user'}/backups` : 'Loading backup status...'}
                      </span>
                      <button
                        onClick={runBackupNow}
                        className="px-4 py-2 rounded-xl text-xs font-semibold transition-smooth hover:scale-105"
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
                      className="flex items-center justify-center gap-2.5 p-4 rounded-2xl border text-xs font-bold transition-smooth hover:scale-[1.01]"
                      style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                    >
                      <Download size={17} className="text-blue-500" />
                      <span>Export Backup (.json)</span>
                    </button>

                    <label
                      className="flex items-center justify-center gap-2.5 p-4 rounded-2xl border text-xs font-bold transition-smooth cursor-pointer hover:scale-[1.01]"
                      style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                    >
                      <Upload size={17} className="text-emerald-500" />
                      <span>Import Backup (.json)</span>
                      <input type="file" accept=".json" onChange={importBackup} className="hidden" />
                    </label>
                  </div>
                </div>
              </TabPanel>
            )}

            {/* 🖥️ DESK CONTROLLER TAB */}
            {activeTab === 'hardware' && (
              <TabPanel
                isPhone={isPhone}
                key="hardware"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
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
                      className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                      style={{ background: hardware.enabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                      aria-pressed={hardware.enabled}
                      title={hardware.enabled ? 'The desk controller is active' : 'The desk controller is ignored'}
                    >
                      <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: hardware.enabled ? 22 : 2 }} />
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
                          className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                          style={{ background: hardware.buttonsEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                          aria-pressed={hardware.buttonsEnabled}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: hardware.buttonsEnabled ? 22 : 2 }} />
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
                          className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-4"
                          style={{ background: hardware.sensorEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                          aria-pressed={hardware.sensorEnabled}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: hardware.sensorEnabled ? 22 : 2 }} />
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
                              className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                              style={{ background: hardware.awayPauseEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                              aria-pressed={hardware.awayPauseEnabled}
                            >
                              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: hardware.awayPauseEnabled ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* Sessions started by hand */}
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <span className="text-xs font-semibold" style={{ color: textPrimary }}>Also control sessions I start myself</span>
                              <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                                A session started from the app, the widget, the hotkey or the phone behaves exactly like one
                                the desk started: leaving pauses it, staying away ends it, and finishing it chains into the
                                next. Turn this off and a hand-started session is left entirely alone.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => patchHardware({ manualFollowsSensor: !hardware.manualFollowsSensor })}
                              className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                              style={{ background: hardware.manualFollowsSensor ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                              aria-pressed={hardware.manualFollowsSensor}
                            >
                              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: hardware.manualFollowsSensor ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* Chaining sessions back to back */}
                          <div className="flex flex-col gap-3">
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <span className="text-xs font-semibold" style={{ color: textPrimary }}>Start the next session automatically</span>
                                <p className="text-[11px] mt-0.5" style={{ color: textSecondary }}>
                                  When a session finishes and you are still sitting there, the next one begins automatically.
                                  Staying put produces no sensor reading to react to, so without this the day stops after the
                                  first session. Stopping one yourself with the terminate button does not restart it — leaving
                                  and returning does.
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => patchHardware({ autoRestartEnabled: !hardware.autoRestartEnabled })}
                                className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                                style={{ background: hardware.autoRestartEnabled ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                                aria-pressed={hardware.autoRestartEnabled}
                              >
                                <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: hardware.autoRestartEnabled ? 22 : 2 }} />
                              </button>
                            </div>

                            {hardware.autoRestartEnabled && (
                              <div className="flex flex-col gap-2 pl-3 border-l-2 ml-1" style={{ borderColor: cardBdr }}>
                                <span className="text-xs font-semibold" style={{ color: textPrimary }}>Grace period before starting next session</span>
                                <p className="text-[11px] -mt-1" style={{ color: textSecondary }}>
                                  Seconds to wait before starting the next session. Set to 0 to start immediately with no delay.
                                </p>
                                <div className="flex items-center gap-2">
                                  <NumberField
                                    min={0}
                                    max={300}
                                    value={hardware.autoRestartArmSeconds ?? 0}
                                    onCommit={n => patchHardware({ autoRestartArmSeconds: n })}
                                    ariaLabel="Next session grace period in seconds"
                                    className="w-24 px-3 py-2 rounded-xl border text-xs outline-none"
                                    style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                                  />
                                  <span className="text-[11px]" style={{ color: textSecondary }}>seconds</span>
                                </div>
                              </div>
                            )}
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
                              className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0 mt-0.5"
                              style={{ background: hardware.announceOnConnect ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                              aria-pressed={hardware.announceOnConnect}
                            >
                              <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: hardware.announceOnConnect ? 22 : 2 }} />
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
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Analysis window (ms)</span>
                            <NumberField
                              min={200} max={10000} step={100}
                              value={hardware.clusterWindowMs}
                              onCommit={n => patchHardware({ clusterWindowMs: n })}
                              ariaLabel="Analysis window, ms"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                            <span className="text-[10px]" style={{ color: textSecondary }}>
                              Every decision is made on the readings from the last{' '}
                              {(hardware.clusterWindowMs / 1000).toFixed(1)}s — roughly{' '}
                              {Math.max(1, Math.round(hardware.clusterWindowMs / hardware.sampleIntervalMs))} of them.
                              The believed distance is the middle of the <span style={{ color: textPrimary }}>largest
                              group that agree with each other</span>, not the average and not the middle value: a
                              cluster keeps describing the real target even when corrupt readings outnumber it, which
                              is exactly what happens when something blocks part of the sensor.
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
                            <span className="text-[10px]" style={{ color: textSecondary }}>
                              The only thing the board still decides for itself. Everything else on this page is
                              worked out on the PC from the raw numbers it sends.
                            </span>
                          </label>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Readings agree within (cm)</span>
                            <NumberField
                              min={1} max={100} step={1}
                              value={hardware.clusterTolCm}
                              onCommit={n => patchHardware({ clusterTolCm: n })}
                              ariaLabel="Readings agree within, cm"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                            <span className="text-[10px]" style={{ color: textSecondary }}>
                              Two readings this close are taken to be measuring the same thing. Widen it if you fidget
                              a lot; narrow it if you and the empty chair read almost the same.
                            </span>
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Spread that means chaos (cm)</span>
                            <NumberField
                              min={5} max={400} step={5}
                              value={hardware.chaosSpreadCm}
                              onCommit={n => patchHardware({ chaosSpreadCm: n })}
                              ariaLabel="Chaotic spread, cm"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                            <span className="text-[10px]" style={{ color: textSecondary }}>
                              When the readings are spread wider than this they are not describing one object, so no
                              departure is read out of them. Leaving a desk produces a <em>quiet</em> signal; a sensor
                              being interfered with produces a loud one.
                            </span>
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
                          A state has to hold this long before it is believed. Arriving is trusted quickly — a sensor
                          with nothing in front of it cannot invent a close reading — while leaving is only ever a
                          theory that has to survive the longer fuse, and any close reading at all resets it.
                        </p>

                        {/* Implausible recessions — the partly-blocked-sensor guard */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Impossible jump (cm)</span>
                            <NumberField
                              min={2} max={200} step={1}
                              value={hardware.rampStepCm}
                              onCommit={n => patchHardware({ rampStepCm: n })}
                              ariaLabel="Impossible jump, cm"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                          <label className="flex flex-col gap-1">
                            <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>…this many in a row</span>
                            <NumberField
                              min={2} max={10} step={1}
                              value={hardware.rampMinSteps}
                              onCommit={n => patchHardware({ rampMinSteps: n })}
                              ariaLabel="Jumps in a row"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </label>
                        </div>
                        <p className="text-[11px] -mt-2" style={{ color: textSecondary }}>
                          This is what stops a partly blocked sensor from evicting you. Rest a foot against half the
                          transducer and the echo path lengthens instead of vanishing, so a seated 30cm walks up
                          through 80 and 120 before finally timing out — and every one of those numbers looks like an
                          ordinary empty chair. {hardware.rampMinSteps} jumps of {hardware.rampStepCm}cm or more in a
                          row is a target receding at metres per second, which nothing sitting at a desk can do, so
                          the readings spanning the jump are <span style={{ color: textPrimary }}>thrown out
                          entirely</span> until the signal settles again. Only where it settles is allowed to mean
                          anything, and a real departure settles on the empty chair within a second.
                        </p>

                        <div className={`grid gap-3 ${hardware.glitchIgnoreAlways ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
                          <div className="flex flex-col gap-1">
                            <div className="flex items-center justify-between gap-2 h-6">
                              <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Implausible beyond (cm)</span>
                              <div
                                onClick={() => patchHardware({ glitchIgnoreAlways: !hardware.glitchIgnoreAlways })}
                                className="flex items-center gap-1.5 cursor-pointer select-none"
                                title="Readings beyond this may never prove you left"
                              >
                                <span className="text-[10px]" style={{ color: textSecondary }}>Never counts as away</span>
                                <button
                                  type="button"
                                  className="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 pointer-events-none"
                                  style={{ background: hardware.glitchIgnoreAlways ? '#3b82f6' : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                                  aria-pressed={hardware.glitchIgnoreAlways}
                                >
                                  <span
                                    className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-smooth"
                                    style={{ left: hardware.glitchIgnoreAlways ? 18 : 2 }}
                                  />
                                </button>
                              </div>
                            </div>
                            <NumberField
                              min={20} max={400} step={5}
                              value={hardware.maxValidCm}
                              onCommit={n => patchHardware({ maxValidCm: n })}
                              validateExtra={n => (n <= hardware.exitCm ? `Must stay above the away distance (${hardware.exitCm})` : null)}
                              ariaLabel="Implausible beyond, cm"
                              className="px-3 py-2 rounded-xl border text-xs outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                          </div>

                          {!hardware.glitchIgnoreAlways && (
                            <div className="flex flex-col gap-1">
                              <div className="flex items-center gap-2 h-6">
                                <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>…unless they hold for (ms)</span>
                              </div>
                              <NumberField
                                min={0} max={120000} step={500}
                                value={hardware.glitchHoldMs}
                                onCommit={n => patchHardware({ glitchHoldMs: n })}
                                ariaLabel="Over-range hold, ms"
                                className="px-3 py-2 rounded-xl border text-xs outline-none"
                                style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                              />
                            </div>
                          )}
                        </div>
                        <p className="text-[11px] -mt-2" style={{ color: textSecondary }}>
                          Leaving is proved in two tiers. Landing on a distance this desk can actually produce — the
                          empty chair, anything up to {hardware.maxValidCm}cm — counts after the{' '}
                          {(hardware.absentConfirmMs / 1000).toFixed(0)}s above. Going past {hardware.maxValidCm}cm is
                          the module&rsquo;s known failure mode rather than a real distance, so{' '}
                          {hardware.glitchIgnoreAlways ? (
                            <>
                              it <span style={{ color: textPrimary }}>never proves you left at all</span>. That is the
                              right setting whenever your empty desk reads inside {hardware.maxValidCm}cm, because
                              then a timeout can only ever be a fault. Leaving is still detected normally, off the
                              empty chair.
                            </>
                          ) : (
                            <>
                              it has to hold unbroken for{' '}
                              {(Math.max(hardware.absentConfirmMs, hardware.glitchHoldMs) / 1000).toFixed(0)}s first,
                              and a single close reading resets that clock from scratch.
                            </>
                          )}
                        </p>

                        <div className="flex flex-col gap-1">
                          <span className="text-[11px] font-semibold" style={{ color: textPrimary }}>Give up after (ms)</span>
                          <NumberField
                            min={0} max={600000} step={5000}
                            value={hardware.chaosMaxMs}
                            onCommit={n => patchHardware({ chaosMaxMs: n })}
                            ariaLabel="Give up after, ms"
                            className="w-32 px-3 py-2 rounded-xl border text-xs outline-none"
                            style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                          />
                          <span className="text-[10px]" style={{ color: textSecondary }}>
                            Every protection above refuses to call you away while the signal is nonsense, which on its
                            own would hold a session open forever against a sensor that has genuinely stopped working.
                            After {(hardware.chaosMaxMs / 1000).toFixed(0)}s of far-but-incoherent readings with not
                            one close reading among them, it stops arguing and calls it away. 0 disables it.
                          </span>
                        </div>
                      </div>

                      <div className="pt-4 border-t flex items-center justify-between gap-4" style={{ borderColor: cardBdr }}>
                        <p className="text-[11px]" style={{ color: textSecondary }}>
                          Pin assignments and the WiFi credentials are the only things still fixed in the firmware.
                        </p>
                        <button
                          type="button"
                          onClick={() => setHardware(DEFAULT_HARDWARE_SETTINGS)}
                          className="touch-target px-3 py-2 rounded-xl border text-xs whitespace-nowrap"
                          style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                        >
                          Reset to defaults
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </TabPanel>
            )}

            {/* 🔗 INTEGRATIONS TAB */}
            {activeTab === 'integrations' && (
              <TabPanel
                isPhone={isPhone}
                key="integrations"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                {/* Unified Master Google Integration Hero Card */}
                <div
                  className="p-5 sm:p-7 rounded-3xl border shadow-sm flex flex-col gap-6 relative overflow-hidden transition-all duration-300"
                  style={{
                    background: cardBg,
                    borderColor: googleSyncEnabled ? (darkMode ? 'rgba(59, 130, 246, 0.4)' : 'rgba(59, 130, 246, 0.3)') : cardBdr,
                  }}
                >
                  {/* Subtle ambient glow when enabled */}
                  {googleSyncEnabled && (
                    <div
                      className="absolute -top-24 -right-24 w-64 h-64 rounded-full pointer-events-none blur-3xl opacity-15"
                      style={{ background: '#3b82f6' }}
                    />
                  )}

                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div className="flex items-start sm:items-center gap-3.5">
                      <div
                        className="p-3 rounded-2xl flex-shrink-0 transition-colors"
                        style={{
                          background: googleSyncEnabled
                            ? (darkMode ? 'rgba(59, 130, 246, 0.18)' : 'rgba(59, 130, 246, 0.12)')
                            : (darkMode ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0, 0, 0, 0.04)'),
                          color: googleSyncEnabled ? '#3b82f6' : textSecondary,
                        }}
                      >
                        {googleSyncEnabled ? <Link2 size={24} /> : <Link2Off size={24} />}
                      </div>
                      <div>
                        <div className="flex items-center gap-2 flex-wrap">
                          <h2 className="text-base font-bold tracking-tight" style={{ color: textPrimary }}>
                            Google Workspace & Calendar Integration
                          </h2>
                          <span
                            className={`px-2 py-0.5 text-[10px] font-bold rounded-full uppercase tracking-wider ${
                              googleSyncEnabled
                                ? (gCalStatus.authenticated
                                    ? 'bg-emerald-500/15 text-emerald-500 border border-emerald-500/30'
                                    : 'bg-blue-500/15 text-blue-500 border border-blue-500/30')
                                : 'bg-slate-500/15 text-slate-400 border border-slate-500/20'
                            }`}
                          >
                            {googleSyncEnabled ? (gCalStatus.authenticated ? 'Active • Connected' : 'Enabled') : 'Disabled'}
                          </span>
                        </div>
                        <p className="text-xs mt-1 leading-relaxed" style={{ color: textSecondary }}>
                          Synchronize events, schedule, and daily tasks bidirectionally with Google Calendar and Google Tasks.
                        </p>
                      </div>
                    </div>

                    {/* Big Unified On/Off Switch Button */}
                    <div className="flex items-center gap-3 self-start sm:self-center">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={googleSyncEnabled}
                        onClick={() => setGoogleSyncEnabled(v => !v)}
                        className="flex items-center gap-3 px-4 py-2.5 rounded-2xl border transition-all duration-200 cursor-pointer select-none group"
                        style={{
                          background: googleSyncEnabled
                            ? (darkMode ? 'rgba(59, 130, 246, 0.15)' : 'rgba(59, 130, 246, 0.08)')
                            : (darkMode ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)'),
                          borderColor: googleSyncEnabled
                            ? '#3b82f6'
                            : (darkMode ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.12)'),
                        }}
                      >
                        <span
                          className="text-xs font-bold tracking-tight transition-colors"
                          style={{ color: googleSyncEnabled ? '#3b82f6' : textSecondary }}
                        >
                          {googleSyncEnabled ? 'Turn OFF' : 'Turn ON'}
                        </span>
                        <div
                          className="relative w-12 h-6 rounded-full transition-colors flex-shrink-0"
                          style={{
                            background: googleSyncEnabled
                              ? accentColor
                              : (darkMode ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.18)'),
                          }}
                        >
                          <span
                            className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-md transition-transform duration-200"
                            style={{
                              transform: googleSyncEnabled ? 'translateX(26px)' : 'translateX(2px)',
                            }}
                          />
                        </div>
                      </button>
                    </div>
                  </div>

                  {/* Informational Banner */}
                  {!googleSyncEnabled ? (
                    <div
                      className="p-4 rounded-2xl border flex items-start gap-3.5"
                      style={{
                        background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)',
                        borderColor: cardBdr,
                      }}
                    >
                      <ShieldCheck size={18} className="text-emerald-500 flex-shrink-0 mt-0.5" />
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold" style={{ color: textPrimary }}>
                          100% Offline & Private Mode
                        </span>
                        <span className="text-xs leading-relaxed" style={{ color: textSecondary }}>
                          Google synchronization is completely turned off. All your calendar events and tasks remain local, private, and secure on this device. No network calls are made to Google, and no authentication warnings will be displayed.
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="p-4 rounded-2xl border flex items-start gap-3.5"
                      style={{
                        background: darkMode ? 'rgba(59,130,246,0.04)' : 'rgba(59,130,246,0.03)',
                        borderColor: darkMode ? 'rgba(59,130,246,0.2)' : 'rgba(59,130,246,0.15)',
                      }}
                    >
                      <Zap size={18} className="text-blue-500 flex-shrink-0 mt-0.5" />
                      <div className="flex flex-col gap-1">
                        <span className="text-xs font-bold" style={{ color: textPrimary }}>
                          Google Synchronization Active
                        </span>
                        <span className="text-xs leading-relaxed" style={{ color: textSecondary }}>
                          The app is configured to communicate with Google Calendar and Google Tasks using your authorized settings below.
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Sub-sections are only shown when googleSyncEnabled is TRUE */}
                {googleSyncEnabled && (
                  <TabPanel
                    isPhone={isPhone}
                    initial={{ opacity: 0, height: 0, y: -6 }}
                    animate={{ opacity: 1, height: 'auto', y: 0 }}
                    exit={{ opacity: 0, height: 0, y: -6 }}
                    transition={{ duration: 0.2 }}
                    className="flex flex-col gap-6"
                  >
                    {/* 1. Account & Connection Status Card */}
                    <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-5" style={{ background: cardBg, borderColor: cardBdr }}>
                      <div>
                        <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                          Account & OAuth Authorization
                        </h2>
                        <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                          Connect your Google account and manage credentials.
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
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
                              className="w-full py-2 px-3 text-xs rounded-xl border outline-none"
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary }}
                            />
                            <input
                              type="password"
                              placeholder="Client Secret"
                              value={clientSecretInput}
                              onChange={e => setClientSecretInput(e.target.value)}
                              autoCapitalize="none"
                              autoCorrect="off"
                              spellCheck={false}
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
                              className="w-full py-2.5 px-4 rounded-xl text-xs font-bold transition-smooth text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50"
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
                                  className="w-full py-2.5 px-4 rounded-xl text-xs font-bold transition-smooth text-white bg-blue-600 hover:bg-blue-700"
                                >
                                  Link Google Account
                                </button>
                              </>
                            ) : (
                              <div className="flex items-center justify-between gap-3">
                                <button
                                  onClick={triggerGCalSync}
                                  disabled={gCalSyncing}
                                  className="flex-1 py-2.5 px-4 rounded-xl text-xs font-bold transition-smooth text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2"
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
                                  className="px-4 py-2.5 rounded-xl text-xs font-bold transition-smooth border text-red-400 border-red-500/20 hover:bg-red-500/10"
                                >
                                  Disconnect
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* 2. Google Sync Policy & Modification Rules */}
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
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                              style={{ background: gcalPushEnabled ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: gcalPushEnabled ? 22 : 2 }} />
                            </button>
                          </div>

                          {/* The option labels are long enough that a non-shrinking
                              select pushes this row off a 390px screen — on a phone
                              it takes its own full-width line. */}
                          <div className={`flex gap-3 pt-2 border-t ${isPhone ? 'flex-col' : 'items-center justify-between'}`} style={{ borderColor: cardBdr }}>
                            <div className="min-w-0 flex-1">
                              <span className="text-xs font-semibold block" style={{ color: textPrimary }}>Google Calendar Destination</span>
                              <span className="text-[11px] block mt-0.5 leading-snug" style={{ color: textSecondary }}>Where newly created app events land on Google Calendar</span>
                            </div>
                            <select
                              value={gcalPushTarget}
                              onChange={e => setGcalPushTarget(e.target.value as 'daily' | 'primary')}
                              className={`py-1.5 px-3 text-xs font-semibold rounded-xl border outline-none cursor-pointer ${isPhone ? 'w-full min-w-0' : 'flex-shrink-0'}`}
                              style={{ background: cardBg, borderColor: cardBdr, color: textPrimary, ...selectTouch }}
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
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                              style={{ background: gcalPushOtherCalendars ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: gcalPushOtherCalendars ? 22 : 2 }} />
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
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                              style={{ background: gcalPullDailyEdits ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: gcalPullDailyEdits ? 22 : 2 }} />
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
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                              style={{ background: gcalPullDailyNew ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: gcalPullDailyNew ? 22 : 2 }} />
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
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                              style={{ background: gcalPullOtherCalendars ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: gcalPullOtherCalendars ? 22 : 2 }} />
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
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                              style={{ background: gcalMirrorLocalDeletions ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: gcalMirrorLocalDeletions ? 22 : 2 }} />
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
                              className="touch-target relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer"
                              style={{ background: gcalMirrorGoogleDeletions ? accentColor : (darkMode ? 'rgba(255,255,255,0.15)' : cardBdr) }}
                            >
                              <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-smooth shadow-sm" style={{ left: gcalMirrorGoogleDeletions ? 22 : 2 }} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* 3. Google Tasks */}
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
                              className="self-start py-2 px-4 rounded-xl text-xs font-bold transition-smooth text-white bg-amber-600 hover:bg-amber-700"
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
                          className="touch-target relative w-11 h-6 rounded-full transition-colors flex-shrink-0"
                          style={{ background: googleTasksSync ? accentColor : (darkMode ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)') }}
                          aria-pressed={googleTasksSync}
                        >
                          <span className="absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-smooth" style={{ left: googleTasksSync ? 22 : 2 }} />
                        </button>
                      </label>
                    </div>
                  </TabPanel>
                )}
              </TabPanel>
            )}

            {/* 👤 ACCOUNT & SECURITY TAB */}
            {activeTab === 'account' && (
              <TabPanel
                isPhone={isPhone}
                key="account"
                initial={{ opacity: 0, y: isPhone ? 0 : 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: isPhone ? 0 : -4 }}
                transition={{ duration: isPhone ? 0.08 : 0.12, ease: 'easeOut' }}
                className="flex flex-col gap-6"
              >
                <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-6" style={{ background: cardBg, borderColor: cardBdr }}>
                  <div>
                    <h2 className="text-sm font-bold tracking-tight" style={{ color: textPrimary }}>
                      User Account & Isolation
                    </h2>
                    <p className="text-xs mt-0.5" style={{ color: textSecondary }}>
                      Manage your session and verify your private database isolation status.
                    </p>
                  </div>

                  {/* Active User Card */}
                  <div className="p-5 rounded-2xl border flex flex-col sm:flex-row sm:items-center justify-between gap-4" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                    <div className="flex items-center gap-3.5 min-w-0">
                      <div className="w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center flex-shrink-0 text-emerald-400">
                        <User size={22} />
                      </div>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold truncate" style={{ color: textPrimary }}>
                            {user?.name || user?.username || 'User'}
                          </span>
                          <span className="text-[10px] font-semibold uppercase px-2 py-0.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                            Active Session
                          </span>
                        </div>
                        <span className="text-xs font-mono block mt-0.5" style={{ color: textSecondary }}>
                          @{user?.username || 'unknown'}
                        </span>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => logout()}
                      className="touch-target flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border font-semibold text-xs transition-all hover:bg-red-500/10 hover:border-red-500/30 text-red-400 cursor-pointer"
                      style={{ borderColor: 'rgba(239, 68, 68, 0.25)', background: 'rgba(239, 68, 68, 0.05)' }}
                    >
                      <LogOut size={15} />
                      <span>Sign Out</span>
                    </button>
                  </div>

                  {/* Database Isolation Status Card */}
                  <div className="p-4 sm:p-5 rounded-2xl border flex flex-col gap-3" style={{ background: darkMode ? 'rgba(16, 185, 129, 0.03)' : 'rgba(16, 185, 129, 0.02)', borderColor: darkMode ? 'rgba(16, 185, 129, 0.2)' : 'rgba(16, 185, 129, 0.15)' }}>
                    <div className="flex items-center gap-2 text-emerald-400">
                      <ShieldCheck size={18} />
                      <span className="text-xs font-bold uppercase tracking-wider">Discrete Database Isolation Active</span>
                    </div>
                    <p className="text-xs leading-relaxed" style={{ color: textSecondary }}>
                      Your events, tasks, settings, focus sessions, prayer checklists, and device preferences are stored strictly inside your dedicated directory (<code className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-300">database/users/{user?.username || 'user'}/</code>). Zero settings or data are shared across users.
                    </p>
                  </div>

                  {/* Managing Users note */}
                  <div className="p-4 rounded-2xl border flex flex-col gap-2" style={{ background: darkMode ? 'rgba(255,255,255,0.015)' : 'rgba(0,0,0,0.015)', borderColor: cardBdr }}>
                    <span className="text-xs font-bold" style={{ color: textPrimary }}>Adding or Managing Users</span>
                    <p className="text-xs leading-relaxed" style={{ color: textSecondary }}>
                      Usernames and passwords are stored securely in <code className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-white/5" style={{ color: textPrimary }}>database/users.json</code> on the host PC. To add a friend or update a password, edit that file on your PC — new users take effect immediately without restarting.
                    </p>
                  </div>

                  {/* Public & Local Access Links */}
                  <div className="p-4 sm:p-5 rounded-2xl border flex flex-col gap-3.5" style={{ background: darkMode ? 'rgba(255,255,255,0.02)' : 'rgba(0,0,0,0.02)', borderColor: cardBdr }}>
                    <div className="flex items-center gap-2" style={{ color: textPrimary }}>
                      <Globe size={17} className="text-blue-400" />
                      <span className="text-xs font-bold uppercase tracking-wider">Access & Sharing Links</span>
                    </div>

                    <div className="flex flex-col gap-2.5">
                      {/* Public Tailscale link */}
                      <div className="p-3 rounded-xl border flex items-center justify-between gap-3" style={{ background: cardBg, borderColor: cardBdr }}>
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Globe size={15} className="text-emerald-400 flex-shrink-0" />
                          <div className="min-w-0">
                            <span className="text-[10px] font-bold uppercase tracking-wider block text-emerald-400">Public Domain Link (Tailscale)</span>
                            <span className="text-xs font-mono truncate block" style={{ color: textPrimary }}>
                              https://mamoun.tail27d0a5.ts.net/
                            </span>
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => {
                            navigator.clipboard.writeText('https://mamoun.tail27d0a5.ts.net/');
                            showToast('Link copied to clipboard!', 'success');
                          }}
                          className="p-2 rounded-lg border hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer"
                          style={{ borderColor: cardBdr, color: textSecondary }}
                          title="Copy Link"
                        >
                          <Copy size={14} />
                        </button>
                      </div>

                      {/* Local Wi-Fi link */}
                      {(() => {
                        const localLanUrl = (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && !window.location.hostname.includes('ts.net')) ? window.location.origin : 'http://192.168.1.118:5173';
                        return (
                          <div className="p-3 rounded-xl border flex items-center justify-between gap-3" style={{ background: cardBg, borderColor: cardBdr }}>
                            <div className="flex items-center gap-2.5 min-w-0">
                              <Wifi size={15} className="text-blue-400 flex-shrink-0" />
                              <div className="min-w-0">
                                <span className="text-[10px] font-bold uppercase tracking-wider block text-blue-400">Local Wi-Fi / LAN Link</span>
                                <span className="text-xs font-mono truncate block" style={{ color: textPrimary }}>
                                  {localLanUrl}
                                </span>
                              </div>
                            </div>
                            <button
                              type="button"
                              onClick={() => {
                                navigator.clipboard.writeText(localLanUrl);
                                showToast('Local Wi-Fi link copied to clipboard!', 'success');
                              }}
                              className="p-2 rounded-lg border hover:bg-white/5 transition-colors flex-shrink-0 cursor-pointer"
                              style={{ borderColor: cardBdr, color: textSecondary }}
                              title="Copy Local Link"
                            >
                              <Copy size={14} />
                            </button>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                </div>
              </TabPanel>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* ── Toast Notifications Stack ───────────────────────────────────────── */}
      {/* A 384px stack anchored 24px from the right runs off the left edge of a
          390px screen, and `bottom-6` puts it under the home bar. On a phone it
          spans the screen instead and clears the inset. */}
      <div
        className={`fixed z-50 flex flex-col gap-2.5 pointer-events-none ${
          isPhone ? 'left-3 right-3' : 'bottom-6 right-6 max-w-sm w-full'
        }`}
        style={isPhone ? { bottom: 'calc(16px + var(--safe-bottom))' } : undefined}
      >
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
    </MotionConfig>
  );
}
