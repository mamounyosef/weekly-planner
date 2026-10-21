// ─── The Tasks panel's per-device view, as stored in this browser ────────────
//
// The sort mode and the selected lists are DEVICE-LOCAL on purpose (the screen
// you happen to be reading is not something the phone should follow), so they
// live in localStorage rather than in the synced settings. Both windows of the
// PC app share one WebView profile, so the main window and the widget read the
// same values. The keys are here, not in the components, because the planning
// assistant reports this view with every message: "the order I see" has to
// mean what this screen shows.

import type { AgentTaskView } from './agent/agentTypes';
import { SETTINGS_STORAGE_KEY } from './settingsSync';
import { ALL_TASK_FILTERS } from './tasks';
import { coerceSortMode } from './taskBoard';

/** The Tasks panel's sort mode. */
export const TASK_SORT_MODE_KEY = 'planner-tasks-sort-mode';
/** The selected task lists, as a JSON array of ids (a bare id from older builds). */
export const ACTIVE_TASK_LIST_KEY = 'planner-active-task-list';

/** The selected list ids as stored; [] is "All lists". */
export function readActiveTaskListIds(): string[] {
  try {
    const raw = localStorage.getItem(ACTIVE_TASK_LIST_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch { /* legacy single-id value */ }
    return [raw];
  } catch { return []; }
}

/** What this device's Tasks panel shows, for the assistant. Never throws. */
export function readTaskView(): AgentTaskView {
  const view: AgentTaskView = { lists: readActiveTaskListIds() };
  try { view.sort = coerceSortMode(localStorage.getItem(TASK_SORT_MODE_KEY)); } catch { /* private mode */ }
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    const filters = raw ? (JSON.parse(raw) as { taskFilters?: unknown }).taskFilters : undefined;
    view.filters = Array.isArray(filters) ? ALL_TASK_FILTERS.filter(f => filters.includes(f)) : [];
  } catch { view.filters = []; }
  return view;
}
