import { SWATCH_BASE_HEX, FALLBACK_EVENT_HEX } from './gcalColor';

export interface EventCategory {
  id: string;
  name: string;
  color: string; // hex code e.g. '#22c55e' or '#f97316'
  // Category-level default behaviors and settings:
  defaultDurationMin?: number; // 15, 30, 45, 60, 90, 120, etc.
  defaultAllDay?: boolean;     // Whether items created in this category default to all-day
  defaultNoCheckbox?: boolean; // Whether items created in this category hide completion checkbox
  showInWidget?: boolean;     // Whether events of this category appear in the side widget (default true)
  isDefault?: boolean;        // Whether this category is automatically selected for new items
  description?: string;        // Optional category notes / description
}

/**
 * Stand-in id for "no category". Real categories can never use it, so the
 * calendar filter can treat uncategorised items as just another row of
 * checkboxes instead of needing a separate flag.
 */
export const UNCATEGORISED = '__none__';

export const DEFAULT_CATEGORIES: EventCategory[] = [
  {
    id: 'personal',
    name: 'Personal',
    color: '#22c55e', // Vibrant green
    defaultDurationMin: 30,
    defaultAllDay: false,
    defaultNoCheckbox: false,
    showInWidget: true,
    description: 'Personal tasks, routines, and life events',
  },
  {
    id: 'university-calendar',
    name: 'University Calender',
    color: '#f97316', // Vivid orange
    defaultDurationMin: 60,
    defaultAllDay: false,
    defaultNoCheckbox: false,
    showInWidget: true,
    description: 'University courses, exams, deadlines, and academic calendar',
  },
];

export const PRESET_CATEGORY_COLORS: Array<{ hex: string; label: string }> = [
  { hex: '#22c55e', label: 'Emerald Green' },
  { hex: '#16a34a', label: 'Forest Green' },
  { hex: '#f97316', label: 'Vivid Orange' },
  { hex: '#ea580c', label: 'Warm Amber' },
  { hex: '#3b82f6', label: 'Royal Blue' },
  { hex: '#0284c7', label: 'Sky Blue' },
  { hex: '#a855f7', label: 'Purple Lilac' },
  { hex: '#7c3aed', label: 'Deep Violet' },
  { hex: '#f43f5e', label: 'Rose Pink' },
  { hex: '#e11d48', label: 'Crimson' },
  { hex: '#14b8a6', label: 'Teal Cyan' },
  { hex: '#eab308', label: 'Golden Sand' },
];

/**
 * Coerce unknown input into a valid list of EventCategories.
 * Fallback to DEFAULT_CATEGORIES if raw is empty or corrupted.
 */
export function coerceCategories(raw: unknown): EventCategory[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    return DEFAULT_CATEGORIES.map(c => ({ ...c }));
  }

  const result: EventCategory[] = [];
  const seenIds = new Set<string>();

  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;

    let id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `cat-${Math.random().toString(36).slice(2, 9)}`;
    if (seenIds.has(id)) {
      id = `${id}-${Math.random().toString(36).slice(2, 6)}`;
    }
    seenIds.add(id);

    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'Unnamed Category';
    
    // Validate color hex
    let color = typeof r.color === 'string' ? r.color.trim() : '';
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
      if (color && SWATCH_BASE_HEX[color]) {
        color = SWATCH_BASE_HEX[color];
      } else {
        color = '#22c55e';
      }
    }

    const cat: EventCategory = {
      id,
      name,
      color,
      defaultDurationMin: typeof r.defaultDurationMin === 'number' && r.defaultDurationMin > 0 ? Math.round(r.defaultDurationMin) : 30,
      defaultAllDay: typeof r.defaultAllDay === 'boolean' ? r.defaultAllDay : false,
      defaultNoCheckbox: typeof r.defaultNoCheckbox === 'boolean' ? r.defaultNoCheckbox : false,
      showInWidget: typeof r.showInWidget === 'boolean' ? r.showInWidget : true,
      isDefault: typeof r.isDefault === 'boolean' ? r.isDefault : false,
      description: typeof r.description === 'string' ? r.description : '',
    };

    result.push(cat);
  }

  // If no valid categories were parsed, return defaults
  if (result.length === 0) {
    return DEFAULT_CATEGORIES.map(c => ({ ...c }));
  }

  return result;
}

/**
 * Resolve the effective color for an event.
 * If the event has a categoryId that exists in categories, that category's color is used.
 * Otherwise, falls back to the event's own color or Google hex.
 */
export function resolveEventColor(
  ev: { color?: string; categoryId?: string | null; gCalHex?: string },
  categories?: EventCategory[],
): string {
  if (ev.categoryId && categories && categories.length > 0) {
    const matched = categories.find(c => c.id === ev.categoryId);
    if (matched && matched.color) {
      return matched.color;
    }
  }

  const c = ev.color;
  if (c && c.startsWith('#')) return c;
  if (ev.gCalHex) return ev.gCalHex;
  return (c && SWATCH_BASE_HEX[c]) || FALLBACK_EVENT_HEX;
}
