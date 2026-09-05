import { SWATCH_BASE_HEX, FALLBACK_EVENT_HEX } from './gcalColor';
import { coerceNotifySpec, type NotifySpec } from './notifications';

export interface EventCategory {
  id: string;
  name: string;
  color: string; // hex code e.g. '#22c55e' or '#f97316'
  // Category-level default behaviors and settings:
  defaultDurationMin?: number; // 0, 15, 30, 45, 60, 90, 120, etc. (0 = no duration / deadline / point in time)
  defaultNoDuration?: boolean; // Whether items created in this category default to no duration (point in time / deadline)
  defaultAllDay?: boolean;     // Whether items created in this category default to all-day
  defaultNoCheckbox?: boolean; // Whether items created in this category hide completion checkbox
  showInWidget?: boolean;     // Whether events of this category appear in the side widget (default true)
  isDefault?: boolean;        // Whether this category is automatically selected for new items
  description?: string;        // Optional category notes / description
  // Category-level notification defaults. An item in this category that has no
  // notification settings of its own inherits these. ABSENT means "inherit the
  // global default" rather than "no notifications", so a category only overrides
  // once it has actually been configured.
  notifyTimed?: NotifySpec;   // applies to items with a time
  notifyAllDay?: NotifySpec;  // applies to all-day items
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
    defaultNoDuration: false,
    defaultAllDay: false,
    defaultNoCheckbox: false,
    showInWidget: true,
    description: 'Personal tasks, routines, and life events',
  },
  {
    id: 'university-calendar',
    name: 'University Calendar',
    color: '#f97316', // Vivid orange
    defaultDurationMin: 60,
    defaultNoDuration: false,
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

    const defaultNoDuration = typeof r.defaultNoDuration === 'boolean'
      ? r.defaultNoDuration
      : (typeof r.defaultDurationMin === 'number' && r.defaultDurationMin === 0);

    const cat: EventCategory = {
      id,
      name,
      color,
      defaultDurationMin: defaultNoDuration ? 0 : (typeof r.defaultDurationMin === 'number' && r.defaultDurationMin > 0 ? Math.round(r.defaultDurationMin) : 30),
      defaultNoDuration,
      defaultAllDay: typeof r.defaultAllDay === 'boolean' ? r.defaultAllDay : false,
      defaultNoCheckbox: typeof r.defaultNoCheckbox === 'boolean' ? r.defaultNoCheckbox : false,
      showInWidget: typeof r.showInWidget === 'boolean' ? r.showInWidget : true,
      isDefault: typeof r.isDefault === 'boolean' ? r.isDefault : false,
      description: typeof r.description === 'string' ? r.description : '',
      // Undefined stays undefined here: it is what "inherits the global
      // default" is stored as, and coercing it into a real spec would silently
      // freeze today's global default onto every category.
      notifyTimed: coerceNotifySpec(r.notifyTimed),
      notifyAllDay: coerceNotifySpec(r.notifyAllDay),
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

// ─── Deleting one, without emptying the list ─────────────────────────────────
// `coerceCategories` treats an empty array as CORRUPT and hands back the two
// built-in categories. That is right for a damaged file and catastrophic for a
// deliberate delete: removing the last category wrote `[]`, the next settings
// snapshot coerced it straight back into Personal and University Calendar, and
// those then broadcast to every device. Two screens offered the same operation
// and only one of them refused. The rule lives here now so all of them share it.

/** What the user is told when the last category is what they tried to remove. */
export const LAST_CATEGORY_MESSAGE = 'You must keep at least one category.';

/** False when `id` is the only category left, or is not in the list at all. */
export function canDeleteCategory(list: readonly EventCategory[], id: string): boolean {
  return list.length > 1 && list.some(c => c.id === id);
}

/**
 * The list without `id`, or the SAME list when that is not allowed.
 *
 * Returning the input unchanged (by reference) rather than throwing lets a
 * caller decide between "nothing happened" and "say why" without a try/catch
 * around a state setter.
 */
export function deleteCategory(
  list: readonly EventCategory[],
  id: string,
): EventCategory[] {
  if (!canDeleteCategory(list, id)) return list as EventCategory[];
  return list.filter(c => c.id !== id);
}
