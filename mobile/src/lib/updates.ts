// ─── Picking up new code from the PC ─────────────────────────────────────────
// The app is configured with `fallbackToCacheTimeout: 0`, which is what keeps a
// cold start instant: it launches on the bundle it already has and never waits
// on the network. The cost of that setting is that expo-updates applies a newly
// downloaded update only on the NEXT launch — so a fix published on the PC
// silently sits unused until the app happens to be killed and reopened.
//
// THAT GAP IS NOT AN ABSTRACT RISK. It is exactly how an evening was lost to
// "sync is still broken": the fixes were live on the PC, the phone had even
// downloaded them, and the screen was still running code from hours earlier.
// Worse, clearing the app's data — the obvious thing to try when an app looks
// broken — deletes the downloaded bundle and drops the app all the way back to
// the one baked into the APK, which is older still. Both failures look
// identical to the user: the app is simply wrong, and nothing says why.
//
// So the update is applied on the next FOREGROUND instead. Launch stays instant,
// and coming back to the app is the one moment where a reload costs nothing:
// the user is not mid-gesture, and every byte of planner data lives in SQLite,
// so a reload is invisible apart from the app being correct afterwards.

import * as Updates from 'expo-updates';

/** Never check more often than this; foregrounding can fire in bursts. */
const MIN_GAP_MS = 60_000;

let lastCheck = 0;
let busy = false;

export interface UpdateOutcome {
  checked: boolean;
  applied: boolean;
  reason?: string;
}

/**
 * Look for a newer bundle and, if there is one, restart into it.
 *
 * Resolves rather than throws on every failure path: an unreachable PC is the
 * normal offline case, not an error worth surfacing. Nothing here is allowed to
 * affect what the user sees except by making the app newer.
 */
export async function applyUpdateIfAny(now = Date.now()): Promise<UpdateOutcome> {
  // In Expo Go and dev builds there is no update to fetch, and calling these
  // throws rather than returning false.
  if (__DEV__ || !Updates.isEnabled) return { checked: false, applied: false, reason: 'disabled' };
  if (busy) return { checked: false, applied: false, reason: 'already checking' };
  if (now - lastCheck < MIN_GAP_MS) return { checked: false, applied: false, reason: 'too soon' };

  busy = true;
  lastCheck = now;
  try {
    const found = await Updates.checkForUpdateAsync();
    if (!found.isAvailable) return { checked: true, applied: false };

    await Updates.fetchUpdateAsync();
    // Past this point the new bundle is on disk and WILL be used on the next
    // launch regardless. Reloading now just stops that being hours away.
    await Updates.reloadAsync();
    return { checked: true, applied: true };
  } catch (err) {
    // Offline, PC asleep, tunnel down, a half-published update — all the same
    // to us: keep running what we have and try again next time.
    return {
      checked: true,
      applied: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  } finally {
    busy = false;
  }
}

/** Testing hook: forget the rate limit. */
export function resetUpdateThrottle(): void {
  lastCheck = 0;
  busy = false;
}
