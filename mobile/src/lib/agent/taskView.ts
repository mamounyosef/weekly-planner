// ─── The Tasks screen's view, for the planning assistant ─────────────────────
//
// The manual order of tasks is ONE order shared by every list and device; what
// differs per screen is how it is sorted and which lists and filters are on.
// The assistant is told this with every message so "the order I see" means
// what this phone's Tasks screen shows. The sort and the selected lists are
// stored prefs; the filters live only in the screen's state, so the screen
// reports them here while it is mounted.

import { prefs } from '../prefs';
import type { AgentTaskView } from './agentTypes';

let liveFilters: string[] = [];

/** Called by the Tasks screen whenever its filter chips change. */
export function setLiveTaskFilters(filters: readonly string[]): void {
  liveFilters = [...filters];
}

/** This phone's Tasks view. Never throws: a missing pref is simply left out. */
export async function readPhoneTaskView(): Promise<AgentTaskView> {
  const view: AgentTaskView = { filters: liveFilters };
  try { view.sort = await prefs.getTaskSort(); } catch { /* left out */ }
  try { view.lists = await prefs.getTaskListFilter(); } catch { /* left out */ }
  return view;
}
