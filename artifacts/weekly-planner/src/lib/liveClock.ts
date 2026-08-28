import { useCallback, useSyncExternalStore } from 'react';

/**
 * A 1-second clock that only the countdown leaves subscribe to.
 * Home publishes ticks; the rest of the planner does not re-render.
 */
let current = Date.now();
const listeners = new Set<() => void>();

export function publishLiveClock(ts = Date.now()) {
  current = ts;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

function getSnapshot() {
  return current;
}

/** Subscribe only while `active` — paused/hidden UIs stay off the 1s path. */
export function useLiveClock(active: boolean): number {
  const maybeSubscribe = useCallback((listener: () => void) => {
    if (!active) return () => {};
    return subscribe(listener);
  }, [active]);
  return useSyncExternalStore(maybeSubscribe, getSnapshot, getSnapshot);
}
