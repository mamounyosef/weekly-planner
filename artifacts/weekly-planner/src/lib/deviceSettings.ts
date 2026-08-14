/**
 * Per-device settings — "how this screen likes to look".
 *
 * Everything in AppSettings is shared: one plan, one set of rules, mirrored to
 * every window and every device through /api/settings. But a handful of those
 * preferences are not about the plan at all — they are about the piece of glass
 * you happen to be holding. Which calendar view fits. How far the app is zoomed.
 * How wide the tasks panel is. Whether the screen is dark.
 *
 * Sharing those across devices is actively wrong: open the planner on a phone,
 * switch to Day view because a 7-column week is unreadable at 390px, and the
 * desktop back home would silently flip to Day view too — and then push it back.
 * So these keys are *lifted out* of the shared settings and stored per device
 * instead, both in localStorage (instant, offline) and on the server keyed by a
 * stable device id (so they survive a cache wipe and are genuinely "remembered
 * every time you open it, on each device").
 *
 * The shared settings file still holds a value for every one of these keys —
 * home.tsx echoes the server's copy back untouched instead of its own — so
 * nothing about the existing sync contract changes, and an older window that
 * knows nothing about devices keeps working exactly as before.
 */
import type {
  AppSettings, DarkPreset, LightPreset, IntervalMin,
  EventCardStyle, SidebarStyle,
} from './settingsSync';

// ── Device identity ─────────────────────────────────────────────────────────

export type DeviceKind = 'phone' | 'tablet' | 'desktop';

const DEVICE_ID_KEY   = 'planner-device-id';
const DEVICE_SETTINGS_KEY = 'planner-device-settings-v1';
const DEVICE_EVENT = 'planner-device-settings-updated';

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch (_) { /* fall through */ }
  return `d-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

let cachedDeviceId: string | null = null;

/** A stable id for this browser profile, minted once and kept forever. */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId;
  try {
    const existing = localStorage.getItem(DEVICE_ID_KEY);
    if (existing) { cachedDeviceId = existing; return existing; }
  } catch (_) { /* private mode — fall through to an ephemeral id */ }
  const fresh = randomId();
  try { localStorage.setItem(DEVICE_ID_KEY, fresh); } catch (_) {}
  cachedDeviceId = fresh;
  return fresh;
}

/**
 * What KIND of screen this is. Deliberately not just a width check: a desktop
 * window dragged narrow is still a desktop (mouse, hover, keyboard), and it must
 * not adopt the phone's saved settings. Coarse pointer + no hover is the signal
 * that actually separates a touchscreen from a small window.
 */
export function getDeviceKind(): DeviceKind {
  if (typeof window === 'undefined') return 'desktop';
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const noHover = window.matchMedia?.('(hover: none)').matches ?? false;
  const touch = coarse || noHover || (navigator.maxTouchPoints ?? 0) > 1;
  // The shortest edge is orientation-proof: a phone in landscape is still a phone.
  const shortEdge = Math.min(window.screen?.width || window.innerWidth, window.screen?.height || window.innerHeight);
  if (!touch) return 'desktop';
  if (shortEdge <= 550) return 'phone';
  return 'tablet';
}

/** A human name for this device, shown in Settings so a stale entry is identifiable. */
export function getDeviceLabel(): string {
  if (typeof navigator === 'undefined') return 'This device';
  const ua = navigator.userAgent;
  const os =
    /Android/i.test(ua)                  ? 'Android'
    : /iPhone/i.test(ua)                 ? 'iPhone'
    : /iPad/i.test(ua)                   ? 'iPad'
    : /Windows/i.test(ua)                ? 'Windows'
    : /Mac OS X|Macintosh/i.test(ua)     ? 'Mac'
    : /Linux/i.test(ua)                  ? 'Linux'
    : 'Device';
  const browser =
    /Edg\//i.test(ua)     ? 'Edge'
    : /OPR\//i.test(ua)   ? 'Opera'
    : /Firefox\//i.test(ua) ? 'Firefox'
    : /Chrome\//i.test(ua) ? 'Chrome'
    : /Safari\//i.test(ua) ? 'Safari'
    : 'Browser';
  const kind = getDeviceKind();
  const kindWord = kind === 'phone' ? 'Phone' : kind === 'tablet' ? 'Tablet' : 'PC';
  return `${os} ${kindWord} · ${browser}`;
}

// ── The settings themselves ─────────────────────────────────────────────────

/**
 * AppSettings keys this device owns. home.tsx must NOT broadcast its own value
 * for any of these — it re-sends whatever the server already had, so two devices
 * with different views never fight (see the settings-sync invariant: partial
 * broadcasts make the pages overwrite each other forever).
 */
export const DEVICE_SCOPED_KEYS = [
  'calendarView', 'customDaysBefore', 'customDaysAfter',
  'interval',
  'tasksPanelOpen', 'tasksPanelWidth', 'showTaskRow',
  'stickyAllDayMain', 'stickyTasksMain',
  'darkMode', 'darkPreset', 'lightPreset',
  'eventColorStyle', 'sidebarStyle',
  'dayStartH', 'dayEndH',
] as const satisfies ReadonlyArray<keyof AppSettings>;

export type DeviceScopedKey = (typeof DEVICE_SCOPED_KEYS)[number];

export const APP_ZOOM_MIN  = 0.5;
export const APP_ZOOM_MAX  = 2.0;
export const APP_ZOOM_STEP = 0.05;

export interface DeviceSettings extends Pick<AppSettings, DeviceScopedKey> {
  /** App zoom (not browser zoom). Has no shared counterpart — always per device. */
  appZoom: number;
  /** Range tab on the focus-analysis screen. */
  analysisTab: 'week' | 'month' | 'year';
  /** Which mobile tab was last open (phone shell only). */
  mobileTab: 'calendar' | 'tasks' | 'focus';
}

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/**
 * First-run values for a brand-new device. Seeded from the shared settings so a
 * new desktop looks like the old one — except on a phone, where a 7-column week
 * at 15-minute resolution with the tasks panel docked open is unusable, so it
 * opens on the day instead.
 */
export function seedDeviceSettings(base: AppSettings, kind: DeviceKind = getDeviceKind()): DeviceSettings {
  const shared: Pick<AppSettings, DeviceScopedKey> = {
    calendarView: base.calendarView, customDaysBefore: base.customDaysBefore,
    customDaysAfter: base.customDaysAfter, interval: base.interval,
    tasksPanelOpen: base.tasksPanelOpen, tasksPanelWidth: base.tasksPanelWidth,
    showTaskRow: base.showTaskRow,
    stickyAllDayMain: base.stickyAllDayMain, stickyTasksMain: base.stickyTasksMain,
    darkMode: base.darkMode, darkPreset: base.darkPreset, lightPreset: base.lightPreset,
    eventColorStyle: base.eventColorStyle, sidebarStyle: base.sidebarStyle,
    dayStartH: base.dayStartH, dayEndH: base.dayEndH,
  };
  if (kind === 'phone') {
    return {
      ...shared,
      calendarView: 'day',
      interval: 30,
      tasksPanelOpen: false,
      appZoom: 1,
      analysisTab: 'week',
      mobileTab: 'calendar',
    };
  }
  if (kind === 'tablet') {
    return { ...shared, calendarView: 'week', tasksPanelOpen: false, appZoom: 1, analysisTab: 'week', mobileTab: 'calendar' };
  }
  return { ...shared, appZoom: 1, analysisTab: 'week', mobileTab: 'calendar' };
}

/** Validate a stored/served blob, filling anything missing from `base`. */
export function coerceDeviceSettings(raw: unknown, base: AppSettings, kind: DeviceKind = getDeviceKind()): DeviceSettings {
  const s = seedDeviceSettings(base, kind);
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;

  if (typeof r.calendarView === 'string' && ['day', 'week', 'month', 'year', 'custom'].includes(r.calendarView)) {
    s.calendarView = r.calendarView;
  }
  if (typeof r.customDaysBefore === 'number') s.customDaysBefore = clampNum(Math.round(r.customDaysBefore), -14, 14);
  if (typeof r.customDaysAfter === 'number') s.customDaysAfter = clampNum(Math.round(r.customDaysAfter), -14, 14);
  if (typeof r.interval === 'number' && [5, 15, 30, 60].includes(r.interval)) s.interval = r.interval as IntervalMin;
  if (typeof r.tasksPanelOpen === 'boolean') s.tasksPanelOpen = r.tasksPanelOpen;
  if (typeof r.tasksPanelWidth === 'number' && Number.isFinite(r.tasksPanelWidth)) {
    s.tasksPanelWidth = clampNum(Math.round(r.tasksPanelWidth), 260, 520);
  }
  if (typeof r.showTaskRow === 'boolean') s.showTaskRow = r.showTaskRow;
  if (typeof r.stickyAllDayMain === 'boolean') s.stickyAllDayMain = r.stickyAllDayMain;
  if (typeof r.stickyTasksMain === 'boolean') s.stickyTasksMain = r.stickyTasksMain;
  if (typeof r.darkMode === 'boolean') s.darkMode = r.darkMode;
  if (typeof r.darkPreset === 'string') s.darkPreset = r.darkPreset as DarkPreset;
  if (typeof r.lightPreset === 'string') s.lightPreset = r.lightPreset as LightPreset;
  if (['tinted', 'solid', 'minimal', 'glowing'].includes(r.eventColorStyle as string)) {
    s.eventColorStyle = r.eventColorStyle as EventCardStyle;
  }
  if (['subtle-glow', 'accent-aura', 'minimal-flat', 'glass-translucent'].includes(r.sidebarStyle as string)) {
    s.sidebarStyle = r.sidebarStyle as SidebarStyle;
  }
  if (typeof r.dayStartH === 'number') s.dayStartH = clampNum(Math.round(r.dayStartH), 0, 23);
  if (typeof r.dayEndH === 'number') s.dayEndH = clampNum(Math.round(r.dayEndH), 1, 48);
  if (typeof r.appZoom === 'number' && Number.isFinite(r.appZoom)) {
    s.appZoom = clampNum(Math.round(r.appZoom / APP_ZOOM_STEP) * APP_ZOOM_STEP, APP_ZOOM_MIN, APP_ZOOM_MAX);
  }
  if (r.analysisTab === 'week' || r.analysisTab === 'month' || r.analysisTab === 'year') s.analysisTab = r.analysisTab;
  if (r.mobileTab === 'calendar' || r.mobileTab === 'tasks' || r.mobileTab === 'focus') s.mobileTab = r.mobileTab;
  return s;
}

/** Splice this device's choices over a shared snapshot, for the values the UI runs on. */
export function mergeDeviceSettings(base: AppSettings, device: DeviceSettings): AppSettings {
  const out = { ...base };
  for (const k of DEVICE_SCOPED_KEYS) {
    (out as unknown as Record<string, unknown>)[k] = (device as unknown as Record<string, unknown>)[k];
  }
  return out;
}

// ── Storage ─────────────────────────────────────────────────────────────────

export function loadDeviceSettingsLocal(): unknown {
  try {
    const str = localStorage.getItem(DEVICE_SETTINGS_KEY);
    return str ? JSON.parse(str) : null;
  } catch (_) { return null; }
}

function saveDeviceSettingsLocal(s: DeviceSettings) {
  try { localStorage.setItem(DEVICE_SETTINGS_KEY, JSON.stringify(s)); } catch (_) {}
}

/**
 * Ask the server what this device last looked like.
 *
 * `kind` is sent along so the server can hand back the most recent settings from
 * a device of the same kind when this id is unknown — clearing the phone's site
 * data then lands you back on your phone layout rather than on the desktop's.
 */
export async function fetchDeviceSettings(): Promise<unknown> {
  try {
    const url = `/api/device-settings?device=${encodeURIComponent(getDeviceId())}&kind=${getDeviceKind()}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const body = await res.json();
    return body && typeof body === 'object' ? (body.settings ?? null) : null;
  } catch (_) { return null; }
}

let pushTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPush: DeviceSettings | null = null;
let lastPushed = '';

/**
 * Persist this device's settings. Written to localStorage synchronously (so a
 * reload is instant and works with the server down) and pushed to the server on
 * a short trailing timer — dragging the zoom stepper or the panel edge changes a
 * value every frame, and one POST per frame is exactly the stall this app has
 * already been bitten by once.
 */
export function saveDeviceSettings(s: DeviceSettings) {
  const json = JSON.stringify(s);
  if (json === lastPushed) return;
  lastPushed = json;
  saveDeviceSettingsLocal(s);
  // Tell the other page on this device immediately. The planner and the settings
  // page both own slices of this object, and they cannot reconcile through
  // /api/settings — that file is shared with every OTHER device, so routing the
  // phone's dark mode through it would put the phone's choice on the desktop.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(DEVICE_EVENT, { detail: s }));
  }
  pendingPush = s;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    const payload = pendingPush;
    pendingPush = null;
    if (!payload) return;
    fetch('/api/device-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device: getDeviceId(),
        kind: getDeviceKind(),
        label: getDeviceLabel(),
        settings: payload,
      }),
    }).catch(() => { /* offline is fine — localStorage already has it */ });
  }, 400);
}

/**
 * Listen for this device's settings changing anywhere on this device — the
 * other page in this tab, or another tab/window of the same browser.
 *
 * Re-entry is safe: saveDeviceSettings ignores a write identical to the last
 * one, so a subscriber that adopts a value and re-saves it stops there rather
 * than ping-ponging.
 */
export function subscribeDeviceSettings(callback: (raw: unknown) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const onCustom = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail) callback(detail);
  };
  const onStorage = (e: StorageEvent) => {
    if (e.key === DEVICE_SETTINGS_KEY && e.newValue) {
      try { callback(JSON.parse(e.newValue)); } catch (_) {}
    }
  };

  window.addEventListener(DEVICE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(DEVICE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}
