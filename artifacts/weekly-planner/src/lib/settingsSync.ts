import { coerceFocusChime, coerceFocusCue, DEFAULT_FOCUS_CUES, type FocusChimeId, type FocusCueId, type FocusCueSlot } from './focusSessions';
import { coerceShortcuts, DEFAULT_SHORTCUTS, type ShortcutMap } from './shortcuts';

export type TimeFormat = '12h' | '24h';
export type IntervalMin = 5 | 15 | 30 | 60;
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type DarkPreset =
  // Deep tones
  | 'pure-black' | 'pitch-graphite' | 'neutral-dark' | 'midnight' | 'deep-emerald' | 'deep-purple'
  // Lighter tones, for when full black is too harsh
  | 'soft-charcoal' | 'ash-gray' | 'gunmetal' | 'slate-storm' | 'warm-espresso' | 'muted-indigo';
export type EventCardStyle = 'tinted' | 'solid' | 'minimal' | 'glowing';
export type SidebarStyle = 'subtle-glow' | 'accent-aura' | 'minimal-flat' | 'glass-translucent';
export type LightPreset =
  | 'clean-white' | 'warm-ivory' | 'cool-slate' | 'soft-lavender' | 'mint-breeze' | 'rose-blush'
  | 'dim-paper' | 'sky-tint' | 'sand-dune';

/** A background theme: page, cards, raised surfaces, hairlines. */
export interface ThemePalette {
  rootBg: string;
  cardBg: string;
  surfaceBg: string;
  surfaceBdr: string;
}

/**
 * The background themes, defined once and shared by the main window, the side
 * window and the settings pickers — so a swatch in settings is literally the
 * colour the window will paint. `label`/`desc` are what settings displays.
 */
export const DARK_PRESETS: Array<{ id: DarkPreset; label: string; desc: string } & ThemePalette> = [
  { id: 'pure-black', label: 'OLED Pure Black', desc: '0% blue, deepest pitch black contrast',
    rootBg: '#050506', cardBg: '#0f1012', surfaceBg: 'rgba(255,255,255,0.05)', surfaceBdr: 'rgba(255,255,255,0.08)' },
  { id: 'pitch-graphite', label: 'Pitch Graphite', desc: 'A step above pure black, charcoal contrast',
    rootBg: '#0a0b0d', cardBg: '#121316', surfaceBg: 'rgba(255,255,255,0.05)', surfaceBdr: 'rgba(255,255,255,0.08)' },
  { id: 'neutral-dark', label: 'Neutral Charcoal', desc: 'Soft modern neutral dark gray',
    rootBg: '#0f1115', cardBg: '#16181e', surfaceBg: 'rgba(255,255,255,0.06)', surfaceBdr: 'rgba(255,255,255,0.09)' },
  { id: 'midnight', label: 'Midnight Blue', desc: 'Deep subtle midnight navy tone',
    rootBg: '#0b0f19', cardBg: '#121824', surfaceBg: 'rgba(255,255,255,0.06)', surfaceBdr: 'rgba(255,255,255,0.10)' },
  { id: 'deep-emerald', label: 'Obsidian Emerald', desc: 'Deep dark emerald green ambiance',
    rootBg: '#080f0c', cardBg: '#101a15', surfaceBg: 'rgba(255,255,255,0.06)', surfaceBdr: 'rgba(255,255,255,0.09)' },
  { id: 'deep-purple', label: 'Obsidian Violet', desc: 'Deep dark violet atmosphere',
    rootBg: '#0e0914', cardBg: '#181220', surfaceBg: 'rgba(255,255,255,0.06)', surfaceBdr: 'rgba(255,255,255,0.10)' },

  // Lighter darks. These sit well above black, so their overlays are dialled up a
  // little — a 5% white wash that reads as a raised surface on pure black just
  // disappears against a mid-gray page.
  { id: 'soft-charcoal', label: 'Soft Charcoal', desc: 'Gently lifted dark gray, easy on the eyes',
    rootBg: '#16181d', cardBg: '#1d2027', surfaceBg: 'rgba(255,255,255,0.07)', surfaceBdr: 'rgba(255,255,255,0.11)' },
  { id: 'ash-gray', label: 'Ash Gray', desc: 'Balanced mid-dark neutral, softer contrast',
    rootBg: '#1c1f26', cardBg: '#23272f', surfaceBg: 'rgba(255,255,255,0.08)', surfaceBdr: 'rgba(255,255,255,0.12)' },
  { id: 'gunmetal', label: 'Gunmetal', desc: 'The lightest dark, muted steel gray',
    rootBg: '#22262e', cardBg: '#2a2f38', surfaceBg: 'rgba(255,255,255,0.09)', surfaceBdr: 'rgba(255,255,255,0.13)' },
  { id: 'slate-storm', label: 'Slate Storm', desc: 'Lighter dark with a cool blue cast',
    rootBg: '#182029', cardBg: '#1f2934', surfaceBg: 'rgba(255,255,255,0.08)', surfaceBdr: 'rgba(255,255,255,0.12)' },
  { id: 'warm-espresso', label: 'Warm Espresso', desc: 'Lighter dark with a warm brown undertone',
    rootBg: '#1c1815', cardBg: '#25201c', surfaceBg: 'rgba(255,255,255,0.07)', surfaceBdr: 'rgba(255,255,255,0.11)' },
  { id: 'muted-indigo', label: 'Muted Indigo', desc: 'Lighter dark washed with soft indigo',
    rootBg: '#1a1c2b', cardBg: '#222537', surfaceBg: 'rgba(255,255,255,0.08)', surfaceBdr: 'rgba(255,255,255,0.12)' },
];

export const LIGHT_PRESETS: Array<{ id: LightPreset; label: string; desc: string } & ThemePalette> = [
  { id: 'clean-white', label: 'Clean White', desc: 'Crisp neutral white, maximum clarity',
    rootBg: '#f8fafc', cardBg: '#ffffff', surfaceBg: '#ffffff', surfaceBdr: 'rgba(0,0,0,0.12)' },
  { id: 'warm-ivory', label: 'Warm Ivory', desc: 'Soft warm off-white parchment',
    rootBg: '#faf8f5', cardBg: '#fffefa', surfaceBg: '#fffefa', surfaceBdr: 'rgba(120,90,50,0.10)' },
  { id: 'cool-slate', label: 'Cool Slate', desc: 'Calm cool-toned light gray',
    rootBg: '#f1f5f9', cardBg: '#f8fafc', surfaceBg: '#f8fafc', surfaceBdr: 'rgba(51,65,85,0.10)' },
  { id: 'soft-lavender', label: 'Soft Lavender', desc: 'Gentle pale violet tint',
    rootBg: '#f5f3ff', cardBg: '#faf8ff', surfaceBg: '#faf8ff', surfaceBdr: 'rgba(109,40,217,0.08)' },
  { id: 'mint-breeze', label: 'Mint Breeze', desc: 'Fresh pale green ambiance',
    rootBg: '#f0fdf4', cardBg: '#f7fef9', surfaceBg: '#f7fef9', surfaceBdr: 'rgba(22,101,52,0.08)' },
  { id: 'rose-blush', label: 'Rose Blush', desc: 'Warm soft pink undertone',
    rootBg: '#fff1f2', cardBg: '#fff5f6', surfaceBg: '#fff5f6', surfaceBdr: 'rgba(190,18,60,0.08)' },
  { id: 'dim-paper', label: 'Dim Paper', desc: 'Muted gray-white, lower glare',
    rootBg: '#e9edf2', cardBg: '#f4f7fa', surfaceBg: '#f4f7fa', surfaceBdr: 'rgba(51,65,85,0.14)' },
  { id: 'sky-tint', label: 'Sky Tint', desc: 'Cool pale blue daylight',
    rootBg: '#eff6ff', cardBg: '#f8fbff', surfaceBg: '#f8fbff', surfaceBdr: 'rgba(29,78,216,0.10)' },
  { id: 'sand-dune', label: 'Sand Dune', desc: 'Warm sandy beige, softer than white',
    rootBg: '#f7f2e8', cardBg: '#fdfaf3', surfaceBg: '#fdfaf3', surfaceBdr: 'rgba(146,109,45,0.12)' },
];

const DARK_PRESET_IDS = DARK_PRESETS.map(p => p.id) as string[];
const LIGHT_PRESET_IDS = LIGHT_PRESETS.map(p => p.id) as string[];

/** Resolve the palette a window should paint, falling back to the default preset. */
export function themePalette(dark: boolean, darkId: DarkPreset, lightId: LightPreset): ThemePalette {
  return dark
    ? (DARK_PRESETS.find(p => p.id === darkId) ?? DARK_PRESETS[0])
    : (LIGHT_PRESETS.find(p => p.id === lightId) ?? LIGHT_PRESETS[0]);
}

export interface AutoBackupCfg {
  enabled: boolean;
  intervalHours: number;
  keep: number;
}

export interface AppSettings {
  interval: IntervalMin;
  darkMode: boolean;
  darkPreset: DarkPreset;
  lightPreset: LightPreset;
  // The side window picks its own background theme — it sits against a different
  // backdrop than the main window, so it gets its own. Everything else about
  // appearance (card style, colours, sidebar accent) is shared between the two.
  widgetDarkPreset: DarkPreset;
  widgetLightPreset: LightPreset;
  eventColorStyle: EventCardStyle;
  sidebarStyle: SidebarStyle;
  timeFormat: TimeFormat;
  weekStartsOn: WeekStartsOn;
  dayStartH: number;
  dayEndH: number;
  calendarView?: string;
  focusDayStartHour: number;
  focusChime: FocusChimeId;
  focusCues: Record<FocusCueSlot, FocusCueId>;
  shortcuts: ShortcutMap;
  autoBackup: AutoBackupCfg;
}

export const DEFAULT_SETTINGS: AppSettings = {
  interval: 15,
  darkMode: true,
  darkPreset: 'pure-black',
  lightPreset: 'clean-white',
  widgetDarkPreset: 'neutral-dark',
  widgetLightPreset: 'clean-white',
  eventColorStyle: 'tinted',
  sidebarStyle: 'subtle-glow',
  timeFormat: '12h',
  weekStartsOn: 1,
  dayStartH: 8,
  dayEndH: 18,
  calendarView: 'week',
  focusDayStartHour: 4,
  focusChime: 'bowl',
  focusCues: DEFAULT_FOCUS_CUES,
  shortcuts: DEFAULT_SHORTCUTS,
  autoBackup: { enabled: true, intervalHours: 24, keep: 50 },
};

const SETTINGS_STORAGE_KEY = 'planner-app-settings-v2';
const SETTINGS_EVENT = 'planner-settings-updated';

export function applyDarkModeClass(isDark: boolean) {
  if (typeof document !== 'undefined') {
    if (isDark) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }
}

export function coerceSettings(raw: unknown): AppSettings {
  const s = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;

  if (typeof r.darkMode === 'boolean') s.darkMode = r.darkMode;
  if (DARK_PRESET_IDS.includes(r.darkPreset as string)) s.darkPreset = r.darkPreset as DarkPreset;
  if (LIGHT_PRESET_IDS.includes(r.lightPreset as string)) s.lightPreset = r.lightPreset as LightPreset;
  if (DARK_PRESET_IDS.includes(r.widgetDarkPreset as string)) s.widgetDarkPreset = r.widgetDarkPreset as DarkPreset;
  if (LIGHT_PRESET_IDS.includes(r.widgetLightPreset as string)) s.widgetLightPreset = r.widgetLightPreset as LightPreset;
  if (['tinted', 'solid', 'minimal', 'glowing'].includes(r.eventColorStyle as string)) {
    s.eventColorStyle = r.eventColorStyle as EventCardStyle;
  }
  if (['subtle-glow', 'accent-aura', 'minimal-flat', 'glass-translucent'].includes(r.sidebarStyle as string)) {
    s.sidebarStyle = r.sidebarStyle as SidebarStyle;
  }
  if (r.timeFormat === '12h' || r.timeFormat === '24h') s.timeFormat = r.timeFormat;
  if (typeof r.interval === 'number' && [5, 15, 30, 60].includes(r.interval)) {
    s.interval = r.interval as IntervalMin;
  }
  if (typeof r.weekStartsOn === 'number' && r.weekStartsOn >= 0 && r.weekStartsOn <= 6) {
    s.weekStartsOn = r.weekStartsOn as WeekStartsOn;
  }
  if (typeof r.dayStartH === 'number') s.dayStartH = r.dayStartH;
  if (typeof r.dayEndH === 'number') s.dayEndH = r.dayEndH;
  if (typeof r.calendarView === 'string') s.calendarView = r.calendarView;
  if (typeof r.focusDayStartHour === 'number') {
    s.focusDayStartHour = Math.max(0, Math.min(23, Math.round(r.focusDayStartHour)));
  }
  if (r.focusChime) s.focusChime = coerceFocusChime(r.focusChime);
  if (r.focusCues && typeof r.focusCues === 'object') {
    const c = r.focusCues as Record<string, unknown>;
    s.focusCues = {
      start: coerceFocusCue(c.start, 'start'),
      pause: coerceFocusCue(c.pause, 'pause'),
      resume: coerceFocusCue(c.resume, 'resume'),
    };
  }
  if (r.shortcuts) s.shortcuts = coerceShortcuts(r.shortcuts);
  if (r.autoBackup && typeof r.autoBackup === 'object') {
    const b = r.autoBackup as Record<string, unknown>;
    s.autoBackup = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : true,
      intervalHours: typeof b.intervalHours === 'number' ? b.intervalHours : 24,
      keep: typeof b.keep === 'number' ? b.keep : 50,
    };
  }
  return s;
}

export function saveSettingsLocal(settings: AppSettings) {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch (_) {}
  applyDarkModeClass(settings.darkMode);
}

export function loadSettingsLocal(): AppSettings {
  try {
    const str = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (str) {
      const parsed = JSON.parse(str);
      const coerced = coerceSettings(parsed);
      applyDarkModeClass(coerced.darkMode);
      return coerced;
    }
  } catch (_) {}
  applyDarkModeClass(DEFAULT_SETTINGS.darkMode);
  return DEFAULT_SETTINGS;
}

let lastSettingsSerialized = '';

/**
 * Key-order-independent serialisation. Settings objects are built by hand on
 * different pages, so two identical states can stringify differently just from
 * literal ordering — which would defeat the echo check below.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function broadcastSettingsChange(input: AppSettings, skipPostBackend = false) {
  // Canonicalise before comparing. Two pages that each own a different slice of
  // the settings used to serialise slightly different objects, so every update
  // looked "new" to the other one — they answered each other forever, hammering
  // the settings file and snapping edits back to stale values mid-typing.
  const settings = coerceSettings(input);
  const json = stableStringify(settings);
  if (json === lastSettingsSerialized) return;
  lastSettingsSerialized = json;

  saveSettingsLocal(settings);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SETTINGS_EVENT, { detail: settings }));
  }

  if (!skipPostBackend) {
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    }).catch(err => console.error('Failed to sync settings to server:', err));
  }
}

export function subscribeSettingsChange(callback: (settings: AppSettings) => void): () => void {
  if (typeof window === 'undefined') return () => {};

  const handleCustom = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail) {
      const coerced = coerceSettings(detail);
      lastSettingsSerialized = stableStringify(coerced);
      callback(coerced);
    }
  };

  const handleStorage = (e: StorageEvent) => {
    if (e.key === SETTINGS_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue);
        const coerced = coerceSettings(parsed);
        lastSettingsSerialized = stableStringify(coerced);
        callback(coerced);
      } catch (_) {}
    }
  };

  window.addEventListener(SETTINGS_EVENT, handleCustom);
  window.addEventListener('storage', handleStorage);

  return () => {
    window.removeEventListener(SETTINGS_EVENT, handleCustom);
    window.removeEventListener('storage', handleStorage);
  };
}
