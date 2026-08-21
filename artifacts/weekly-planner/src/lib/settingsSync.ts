import { coerceFocusChime, coerceFocusCue, DEFAULT_FOCUS_CUES, type FocusChimeId, type FocusCueId, type FocusCueSlot } from './focusSessions';
import { coerceShortcuts, DEFAULT_SHORTCUTS, type ShortcutMap } from './shortcuts';
import { coerceHardwareSettings, DEFAULT_HARDWARE_SETTINGS, type HardwareSettings } from './hardwareController';
import { coercePrayerSettings, DEFAULT_PRAYER_SETTINGS, type PrayerSettings } from './prayerTimes';
import { coerceCategories, DEFAULT_CATEGORIES, type EventCategory } from './categories';
import { coerceTaskLists, DEFAULT_TASK_LISTS, type TaskList } from './taskLists';

export type TimeFormat = '12h' | '24h';
export type IntervalMin = 5 | 15 | 30 | 60;
export type WeekStartsOn = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export type DarkPreset =
  // Deep tones
  | 'pure-black' | 'pitch-graphite' | 'neutral-dark' | 'midnight' | 'deep-emerald' | 'deep-purple'
  // Lighter tones, for when full black is too harsh
  | 'soft-charcoal' | 'ash-gray' | 'gunmetal' | 'slate-storm' | 'warm-espresso' | 'muted-indigo'
  // Expanded range
  | 'forest-night' | 'copper-ember' | 'arctic-dusk' | 'plum-wine' | 'carbon-moss' | 'ink-teal'
  | 'volcanic-ash' | 'night-rose' | 'deep-aubergine' | 'smoked-olive' | 'steel-cyan' | 'black-cherry'
  | 'luminous-contrast';
export type EventCardStyle = 'tinted' | 'solid' | 'minimal' | 'glowing';
export type SidebarStyle = 'subtle-glow' | 'accent-aura' | 'minimal-flat' | 'glass-translucent';
export type LightPreset =
  | 'clean-white' | 'warm-ivory' | 'cool-slate' | 'soft-lavender' | 'mint-breeze' | 'rose-blush'
  | 'dim-paper' | 'sky-tint' | 'sand-dune'
  | 'pearl-blue' | 'sage-paper' | 'buttercream' | 'clay-blush' | 'misty-lilac' | 'seafoam'
  | 'linen-graphite' | 'frosted-mint' | 'porcelain-rose' | 'pale-apricot' | 'silver-lake' | 'soft-coral';

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
  { id: 'forest-night', label: 'Forest Night', desc: 'Cool pine-black with grounded green depth',
    rootBg: '#07110d', cardBg: '#0f1b16', surfaceBg: 'rgba(255,255,255,0.065)', surfaceBdr: 'rgba(187,247,208,0.12)' },
  { id: 'copper-ember', label: 'Copper Ember', desc: 'Dark mineral copper without heavy brown',
    rootBg: '#160f0b', cardBg: '#211713', surfaceBg: 'rgba(255,255,255,0.065)', surfaceBdr: 'rgba(251,146,60,0.13)' },
  { id: 'arctic-dusk', label: 'Arctic Dusk', desc: 'Blue-gray night with crisp icy contrast',
    rootBg: '#0b1218', cardBg: '#121d25', surfaceBg: 'rgba(255,255,255,0.07)', surfaceBdr: 'rgba(125,211,252,0.13)' },
  { id: 'plum-wine', label: 'Plum Wine', desc: 'Deep muted plum, softer than violet',
    rootBg: '#150d16', cardBg: '#211622', surfaceBg: 'rgba(255,255,255,0.065)', surfaceBdr: 'rgba(244,114,182,0.12)' },
  { id: 'carbon-moss', label: 'Carbon Moss', desc: 'Charcoal base with restrained olive warmth',
    rootBg: '#121510', cardBg: '#1b2018', surfaceBg: 'rgba(255,255,255,0.07)', surfaceBdr: 'rgba(190,242,100,0.11)' },
  { id: 'ink-teal', label: 'Ink Teal', desc: 'Dark ink with a clean teal undertone',
    rootBg: '#061213', cardBg: '#0e1d1f', surfaceBg: 'rgba(255,255,255,0.07)', surfaceBdr: 'rgba(45,212,191,0.13)' },
  { id: 'volcanic-ash', label: 'Volcanic Ash', desc: 'Soft blackened gray with subtle warmth',
    rootBg: '#131313', cardBg: '#1e1d1b', surfaceBg: 'rgba(255,255,255,0.075)', surfaceBdr: 'rgba(255,255,255,0.12)' },
  { id: 'night-rose', label: 'Night Rose', desc: 'Dark rose tone with low-glare contrast',
    rootBg: '#170c10', cardBg: '#23151a', surfaceBg: 'rgba(255,255,255,0.065)', surfaceBdr: 'rgba(251,113,133,0.13)' },
  { id: 'deep-aubergine', label: 'Deep Aubergine', desc: 'Blackened eggplant, rich but controlled',
    rootBg: '#120b18', cardBg: '#1d1426', surfaceBg: 'rgba(255,255,255,0.07)', surfaceBdr: 'rgba(196,181,253,0.12)' },
  { id: 'smoked-olive', label: 'Smoked Olive', desc: 'Muted green-brown for a quiet desk feel',
    rootBg: '#15160f', cardBg: '#202116', surfaceBg: 'rgba(255,255,255,0.07)', surfaceBdr: 'rgba(217,249,157,0.10)' },
  { id: 'steel-cyan', label: 'Steel Cyan', desc: 'Industrial blue-cyan dark, clean and sharp',
    rootBg: '#0a1317', cardBg: '#111f25', surfaceBg: 'rgba(255,255,255,0.075)', surfaceBdr: 'rgba(103,232,249,0.13)' },
  { id: 'black-cherry', label: 'Black Cherry', desc: 'Near-black burgundy with polished depth',
    rootBg: '#14090d', cardBg: '#211116', surfaceBg: 'rgba(255,255,255,0.065)', surfaceBdr: 'rgba(248,113,113,0.12)' },
  { id: 'luminous-contrast', label: 'Luminous Contrast', desc: 'Very light dark mode with vivid high-contrast surfaces',
    rootBg: '#384151', cardBg: '#4b5568', surfaceBg: 'rgba(255,255,255,0.16)', surfaceBdr: 'rgba(255,255,255,0.28)' },
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
  { id: 'pearl-blue', label: 'Pearl Blue', desc: 'Pearl white with a soft blue cast',
    rootBg: '#f3f8fb', cardBg: '#ffffff', surfaceBg: '#ffffff', surfaceBdr: 'rgba(37,99,235,0.10)' },
  { id: 'sage-paper', label: 'Sage Paper', desc: 'Muted green-gray, calm and natural',
    rootBg: '#f1f6ef', cardBg: '#fbfdf9', surfaceBg: '#fbfdf9', surfaceBdr: 'rgba(74,124,89,0.12)' },
  { id: 'buttercream', label: 'Buttercream', desc: 'Pale creamy yellow without glare',
    rootBg: '#fff9e8', cardBg: '#fffdf5', surfaceBg: '#fffdf5', surfaceBdr: 'rgba(202,138,4,0.12)' },
  { id: 'clay-blush', label: 'Clay Blush', desc: 'Warm clay-pink with a handmade feel',
    rootBg: '#fbf1ed', cardBg: '#fff8f5', surfaceBg: '#fff8f5', surfaceBdr: 'rgba(194,65,12,0.11)' },
  { id: 'misty-lilac', label: 'Misty Lilac', desc: 'Cool lilac-gray, quieter than lavender',
    rootBg: '#f4f1f8', cardBg: '#fcfaff', surfaceBg: '#fcfaff', surfaceBdr: 'rgba(126,34,206,0.09)' },
  { id: 'seafoam', label: 'Seafoam', desc: 'Light aqua green with fresh contrast',
    rootBg: '#edfdfa', cardBg: '#f8fffd', surfaceBg: '#f8fffd', surfaceBdr: 'rgba(13,148,136,0.10)' },
  { id: 'linen-graphite', label: 'Linen Graphite', desc: 'Neutral linen with graphite edges',
    rootBg: '#f4f4f1', cardBg: '#fdfdfb', surfaceBg: '#fdfdfb', surfaceBdr: 'rgba(63,63,70,0.13)' },
  { id: 'frosted-mint', label: 'Frosted Mint', desc: 'Cool mint-white, clean and airy',
    rootBg: '#f2fbf6', cardBg: '#fbfffd', surfaceBg: '#fbfffd', surfaceBdr: 'rgba(5,150,105,0.10)' },
  { id: 'porcelain-rose', label: 'Porcelain Rose', desc: 'Porcelain white with rose undertones',
    rootBg: '#fff5f7', cardBg: '#fffdfd', surfaceBg: '#fffdfd', surfaceBdr: 'rgba(225,29,72,0.09)' },
  { id: 'pale-apricot', label: 'Pale Apricot', desc: 'Soft apricot warmth, brighter than sand',
    rootBg: '#fff4ea', cardBg: '#fffaf5', surfaceBg: '#fffaf5', surfaceBdr: 'rgba(234,88,12,0.10)' },
  { id: 'silver-lake', label: 'Silver Lake', desc: 'Cool silver-blue gray for lower glare',
    rootBg: '#edf2f5', cardBg: '#f8fbfd', surfaceBg: '#f8fbfd', surfaceBdr: 'rgba(71,85,105,0.13)' },
  { id: 'soft-coral', label: 'Soft Coral', desc: 'Warm coral tint with crisp white surfaces',
    rootBg: '#fff0ed', cardBg: '#fff9f7', surfaceBg: '#fff9f7', surfaceBdr: 'rgba(220,38,38,0.09)' },
];

export const DARK_PRESET_IDS = DARK_PRESETS.map(p => p.id) as string[];
export const LIGHT_PRESET_IDS = LIGHT_PRESETS.map(p => p.id) as string[];

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

export type TaskCheckboxShape = 'circle' | 'square';

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
  // Custom view window: how many days to show BEFORE the week start, and how many
  // to show FROM the week start onwards (total columns = before + after).
  customDaysBefore: number;
  customDaysAfter: number;
  customAnchor?: 'day' | 'week';
  focusDayStartHour: number;
  focusChime: FocusChimeId;
  focusCues: Record<FocusCueSlot, FocusCueId>;
  shortcuts: ShortcutMap;
  autoBackup: AutoBackupCfg;
  // ── Tasks ──────────────────────────────────────────────────────────────────
  tasksPanelOpen: boolean;   // the right-hand tasks panel; open by default
  tasksPanelWidth: number;   // 260–520
  showTaskRow: boolean;      // the dated-task band under All Day
  taskColor: string;         // '#rrggbb' — the one colour tasks wear on the grid
  taskCheckboxShape: TaskCheckboxShape; // 'circle' | 'square'
  taskFilters: string[];     // panel filter selection; empty = show everything
  autoRollRecurringTasks: boolean; // when next occurrence arrives, roll overdue repeating tasks to Today
  googleSyncEnabled: boolean;         // Master toggle for Google integration & synchronization
  googleTasksSync: boolean;
  // ── Sticky Header Bands ───────────────────────────────────────────────────
  stickyAllDayMain: boolean;   // Sticky All-Day Events row in Main Window
  stickyTasksMain: boolean;    // Sticky Tasks row in Main Window
  stickyAllDayWidget: boolean; // Sticky All-Day Events row in Sidebar Widget
  stickyTasksWidget: boolean;  // Sticky Tasks row in Sidebar Widget
  // ── Google Calendar Sync Policies ──────────────────────────────────────────
  gcalPushEnabled: boolean;           // Master push toggle (app → Google)
  gcalPushTarget: 'daily' | 'primary'; // Destination calendar on Google ('daily' | 'primary')
  gcalPushOtherCalendars: boolean;    // Allow local edits to external Google Calendar events to push back to Google
  gcalPullDailyEdits: boolean;        // Allow Google edits to Daily Calendar to modify local app events (DEFAULT: false = Protected)
  gcalPullDailyNew: boolean;          // Import new events created directly on Google's Daily Calendar into app (DEFAULT: false)
  gcalPullOtherCalendars: boolean;    // Import events from other Google Calendars (Primary, Work, etc.) as read-only cards
  gcalMirrorLocalDeletions: boolean;  // Deleting an event in app deletes it on Google Calendar
  gcalMirrorGoogleDeletions: boolean; // Deleting an event on Google's Daily Calendar deletes it in app
  // ── Prayer times ───────────────────────────────────────────────────────────
  prayer: PrayerSettings;
  // ── ESP32 desk controller ──────────────────────────────────────────────────
  hardware: HardwareSettings;
  shortcutDefaultsVersion?: number;
  // ── Categories ─────────────────────────────────────────────────────────────
  categories: EventCategory[];
  /** Sections of the Tasks page. Always contains General. */
  taskLists: TaskList[];
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
  dayStartH: 0,
  dayEndH: 24,
  calendarView: 'week',
  customDaysBefore: 0,
  customDaysAfter: 0,
  customAnchor: 'day',
  focusDayStartHour: 4,
  focusChime: 'breath',
  focusCues: DEFAULT_FOCUS_CUES,
  shortcuts: DEFAULT_SHORTCUTS,
  autoBackup: { enabled: true, intervalHours: 24, keep: 50 },
  tasksPanelOpen: true,
  tasksPanelWidth: 340,
  showTaskRow: true,
  taskColor: '#7dd3fc',
  taskCheckboxShape: 'circle',
  taskFilters: [],
  autoRollRecurringTasks: true,
  googleSyncEnabled: false,
  googleTasksSync: true,
  stickyAllDayMain: true,
  stickyTasksMain: true,
  stickyAllDayWidget: true,
  stickyTasksWidget: true,
  gcalPushEnabled: true,
  gcalPushTarget: 'daily',
  gcalPushOtherCalendars: true,
  gcalPullDailyEdits: false,
  gcalPullDailyNew: false,
  gcalPullOtherCalendars: true,
  gcalMirrorLocalDeletions: true,
  gcalMirrorGoogleDeletions: false,
  prayer: DEFAULT_PRAYER_SETTINGS,
  hardware: DEFAULT_HARDWARE_SETTINGS,
  categories: DEFAULT_CATEGORIES,
  taskLists: DEFAULT_TASK_LISTS,
};

export const TASK_PANEL_MIN_W = 260;
export const TASK_PANEL_MAX_W = 520;
// Canonical filter order. `taskFilters` MUST always be stored in this order:
// the echo guard below stringifies arrays without sorting them, so the same
// selection in two different orders would make the pages overwrite each other
// forever. (Mirrors ALL_TASK_FILTERS in lib/tasks.ts — kept local to avoid a
// settings ⇄ tasks import cycle.)
const TASK_FILTER_ORDER = ['today', 'overdue', 'upcoming', 'general', 'completed'];

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
  if (typeof r.dayStartH === 'number') s.dayStartH = Math.max(0, Math.min(23, Math.round(r.dayStartH)));
  if (typeof r.dayEndH === 'number') s.dayEndH = Math.max(1, Math.min(48, Math.round(r.dayEndH)));
  if (s.dayEndH <= s.dayStartH) {
    s.dayEndH = Math.min(48, s.dayStartH + 1);
  }
  if (typeof r.calendarView === 'string') s.calendarView = r.calendarView;
  if (typeof r.customDaysBefore === 'number') s.customDaysBefore = Math.max(-14, Math.min(14, Math.round(r.customDaysBefore)));
  if (typeof r.customDaysAfter === 'number') s.customDaysAfter = Math.max(-14, Math.min(14, Math.round(r.customDaysAfter)));
  if (r.customAnchor === 'day' || r.customAnchor === 'week') s.customAnchor = r.customAnchor;
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
  if (typeof r.tasksPanelOpen === 'boolean') s.tasksPanelOpen = r.tasksPanelOpen;
  if (typeof r.tasksPanelWidth === 'number' && Number.isFinite(r.tasksPanelWidth)) {
    s.tasksPanelWidth = Math.max(TASK_PANEL_MIN_W, Math.min(TASK_PANEL_MAX_W, Math.round(r.tasksPanelWidth)));
  }
  if (typeof r.showTaskRow === 'boolean') s.showTaskRow = r.showTaskRow;
  if (typeof r.taskColor === 'string' && /^#[0-9a-f]{6}$/i.test(r.taskColor)) s.taskColor = r.taskColor;
  if (['circle', 'square'].includes(r.taskCheckboxShape as string)) {
    s.taskCheckboxShape = r.taskCheckboxShape as TaskCheckboxShape;
  }
  if (Array.isArray(r.taskFilters)) {
    // Re-derived in canonical order, so an out-of-order array can never round-trip.
    s.taskFilters = TASK_FILTER_ORDER.filter(f => (r.taskFilters as unknown[]).includes(f));
  }
  if (typeof r.autoRollRecurringTasks === 'boolean') s.autoRollRecurringTasks = r.autoRollRecurringTasks;
  if (typeof r.googleSyncEnabled === 'boolean') s.googleSyncEnabled = r.googleSyncEnabled;
  if (typeof r.googleTasksSync === 'boolean') s.googleTasksSync = r.googleTasksSync;
  if (typeof r.stickyAllDayMain === 'boolean') s.stickyAllDayMain = r.stickyAllDayMain;
  if (typeof r.stickyTasksMain === 'boolean') s.stickyTasksMain = r.stickyTasksMain;
  if (typeof r.stickyAllDayWidget === 'boolean') s.stickyAllDayWidget = r.stickyAllDayWidget;
  if (typeof r.stickyTasksWidget === 'boolean') s.stickyTasksWidget = r.stickyTasksWidget;
  if (typeof r.gcalPushEnabled === 'boolean') s.gcalPushEnabled = r.gcalPushEnabled;
  if (r.gcalPushTarget === 'daily' || r.gcalPushTarget === 'primary') s.gcalPushTarget = r.gcalPushTarget;
  if (typeof r.gcalPushOtherCalendars === 'boolean') s.gcalPushOtherCalendars = r.gcalPushOtherCalendars;
  if (typeof r.gcalPullDailyEdits === 'boolean') s.gcalPullDailyEdits = r.gcalPullDailyEdits;
  if (typeof r.gcalPullDailyNew === 'boolean') s.gcalPullDailyNew = r.gcalPullDailyNew;
  if (typeof r.gcalPullOtherCalendars === 'boolean') s.gcalPullOtherCalendars = r.gcalPullOtherCalendars;
  if (typeof r.gcalMirrorLocalDeletions === 'boolean') s.gcalMirrorLocalDeletions = r.gcalMirrorLocalDeletions;
  if (typeof r.gcalMirrorGoogleDeletions === 'boolean') s.gcalMirrorGoogleDeletions = r.gcalMirrorGoogleDeletions;
  if (r.prayer != null) s.prayer = coercePrayerSettings(r.prayer);
  if (r.hardware != null) s.hardware = coerceHardwareSettings(r.hardware);
  if (r.categories != null) s.categories = coerceCategories(r.categories);
  if (r.taskLists != null) s.taskLists = coerceTaskLists(r.taskLists);
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
