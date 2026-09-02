// ─── A clock that a screen can actually depend on ────────────────────────────
// The calendar reads `new Date()` during render and draws a line across the
// current time from it. That only works if something re-renders it once a
// minute, and for a long while nothing did on purpose: it happened to be
// re-rendered by the notification centre's own thirty-second tick, arriving
// through the planner context.
//
// That is not a clock, it is a coincidence, and it was an expensive one — the
// tick re-rendered every screen in the app to move a line on one of them. This
// is the clock, stated outright, where the screen that needs it can hold it.
//
// TWO THINGS IT DOES THAT A PLAIN `setInterval` DOES NOT:
//
//   • it lands ON the minute rather than sixty seconds after mount, so the line
//     moves when the phone's clock says it should and not up to a minute late;
//   • it re-reads the time the instant the app is foregrounded, because Android
//     freezes timers while the app is away and coming back to a clock that says
//     what it said an hour ago is the one failure everybody notices.

import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

/**
 * The current time, re-read at the start of every minute.
 *
 * Returns a `Date`, so callers that want the day, the minute, or both read it
 * from one consistent value rather than calling `new Date()` twice and getting
 * two different answers either side of midnight.
 */
export function useNowMinute(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const tick = () => {
      if (stopped) return;
      const at = new Date();
      setNow(at);
      // Aim at the next whole minute. A second of slack keeps a slightly early
      // wake-up from firing twice for the same minute.
      const msIntoMinute = at.getSeconds() * 1_000 + at.getMilliseconds();
      timer = setTimeout(tick, 60_000 - msIntoMinute + 1_000);
    };

    // Sets the time immediately as well as scheduling the next one, which is
    // what makes a foreground feel instant rather than up to a minute stale.
    tick();

    const sub = AppState.addEventListener('change', state => {
      if (state !== 'active') return;
      if (timer) clearTimeout(timer);
      tick();
    });

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, []);

  return now;
}
