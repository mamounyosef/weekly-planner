import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildPrayerDay,
  coercePrayerDone,
  isPrayerDone,
  monthsForDates,
  prayerDateKey,
  prayerMonthUrl,
  prayerQueryKey,
  togglePrayerDone,
  withinPrayerHorizon,
  type PrayerDoneMap,
  type PrayerKey,
  type PrayerMonth,
  type PrayerOccurrence,
  type PrayerSettings,
} from './prayerTimes';

/**
 * Loads the prayer calendar for whatever days are on screen and exposes the
 * tick-off state. Both windows use this — the server owns the Aladhan cache, so
 * a second window costs no extra API calls.
 */
export function usePrayerTimes(settings: PrayerSettings, visibleDates: Date[]) {
  const [months, setMonths] = useState<Record<string, PrayerMonth>>({});
  const [done, setDone] = useState<PrayerDoneMap>({});
  const [stale, setStale] = useState(false);
  const inFlight = useRef<Set<string>>(new Set());
  const queryKey = prayerQueryKey(settings);
  // Cached months belong to one location+method; changing either invalidates all
  // of them, so they're stored under the query key and dropped when it changes.
  const loadedKey = useRef(queryKey);

  const needed = useMemo(() => monthsForDates(visibleDates), [visibleDates]);
  const neededSig = needed.join(',');

  useEffect(() => {
    if (loadedKey.current !== queryKey) {
      loadedKey.current = queryKey;
      inFlight.current.clear();
      setMonths({});
    }
  }, [queryKey]);

  // ── Load the months on screen ──────────────────────────────────────────────
  useEffect(() => {
    if (!settings.enabled) return;
    // Deliberately NO cleanup flag. `inFlight` is a ref, so it survives the
    // mount → unmount → remount that React does in dev; discarding the reply on
    // unmount would leave the month marked in-flight, skipped on the remount,
    // and therefore never loaded at all. A late setState on a dead component is
    // a no-op — stale REPLIES are rejected by the query key instead.
    const keyAtStart = queryKey;

    for (const ym of neededSig ? neededSig.split(',') : []) {
      const flightKey = `${keyAtStart}:${ym}`;
      if (months[ym] || inFlight.current.has(flightKey)) continue;
      inFlight.current.add(flightKey);
      const [y, m] = ym.split('-').map(Number);
      fetch(prayerMonthUrl(settings, y, m))
        .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then(data => {
          if (loadedKey.current !== keyAtStart) return; // city/method changed mid-flight
          if (data?.days) setMonths(prev => ({ ...prev, [ym]: data.days }));
          if (data?.stale) setStale(true);
        })
        .catch(err => console.error('Prayer times fetch failed:', err))
        .finally(() => { inFlight.current.delete(flightKey); });
    }
    // `months` is intentionally read but not a dependency: adding it would re-run
    // this on every successful load and re-check months already in hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [neededSig, queryKey, settings.enabled]);

  // ── Re-check with the API once a day ───────────────────────────────────────
  // Prayer times drift a minute or two every day and the whole point of using an
  // API is not going stale, so the current month is dropped (and so re-fetched)
  // whenever the calendar date rolls over.
  const dayStamp = prayerDateKey(new Date());
  const lastDayStamp = useRef(dayStamp);
  useEffect(() => {
    const tick = () => {
      const today = prayerDateKey(new Date());
      if (today === lastDayStamp.current) return;
      lastDayStamp.current = today;
      const now = new Date();
      const ym = `${now.getFullYear()}-${now.getMonth() + 1}`;
      setMonths(prev => {
        const next = { ...prev };
        delete next[ym];
        return next;
      });
    };
    const id = window.setInterval(tick, 5 * 60 * 1000);
    return () => window.clearInterval(id);
  }, []);

  // ── Done state, shared through the server like every other store ───────────
  const pullDone = useCallback(() => {
    fetch('/api/prayer-done')
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(data => setDone(coercePrayerDone(data)))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!settings.enabled) return;
    pullDone();
    const id = window.setInterval(pullDone, 20000);
    return () => window.clearInterval(id);
  }, [pullDone, settings.enabled]);

  const doneRef = useRef(done);
  doneRef.current = done;

  const toggleDone = useCallback((dateStr: string, key: PrayerKey) => {
    const next = togglePrayerDone(doneRef.current, dateStr, key);
    setDone(next);
    const url = Object.keys(next).length === 0 ? '/api/prayer-done?force=1' : '/api/prayer-done';
    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(next),
    }).catch(err => console.error('Failed to save prayer completion:', err));
  }, []);

  /** Prayers to draw on one day — empty when disabled or past the horizon. */
  const prayersFor = useCallback((date: Date): PrayerOccurrence[] => {
    if (!settings.enabled) return [];
    const dateStr = prayerDateKey(date);
    if (!withinPrayerHorizon(dateStr, settings)) return [];
    const ym = `${date.getFullYear()}-${date.getMonth() + 1}`;
    return buildPrayerDay(dateStr, months[ym]?.[dateStr], settings);
  }, [months, settings]);

  /**
   * The day's raw times, before any of the "which ones to show" settings are
   * applied — for places that deliberately show everything (the header panel
   * lists Sunrise even when the grid is set to hide it).
   */
  const rawTimesFor = useCallback((date: Date) => {
    const ym = `${date.getFullYear()}-${date.getMonth() + 1}`;
    return months[ym]?.[prayerDateKey(date)];
  }, [months]);

  const isDone = useCallback(
    (dateStr: string, key: PrayerKey) => isPrayerDone(done, dateStr, key),
    [done],
  );

  return { prayersFor, rawTimesFor, isDone, toggleDone, stale };
}
