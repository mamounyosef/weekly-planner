// ─── Not building the same day five times in one frame ───────────────────────
// `buildDay` walks every event in the planner and asks the recurrence engine
// whether it falls on the date in question. On a real planner that is around
// 1.6ms per day in V8 and several times that under Hermes. Fine once. The month
// view asks for forty-two days, and asks again for every render.
//
// So the answers are kept. The rule that makes that safe rather than a source
// of stale screens:
//
//   THE CACHE IS THE DATA. It is created alongside the events, the tasks, the
//   week start and the categories it was built from, and thrown away whole the
//   instant any of them changes — it is never invalidated entry by entry,
//   because "which entries did that edit affect" is a question with a subtle
//   wrong answer (a repeat can move, a category can recolour every occurrence)
//   and getting it wrong shows the user an event that is no longer there.
//
// The one input that is NOT part of that identity is what day it is now, which
// decides whether undated tasks are included. That travels in the key instead,
// so an app left open across midnight simply starts asking different questions
// rather than being handed yesterday's answers.

export interface KeyedCache<V> {
  /** The stored answer, or a freshly built one. */
  get(key: string): V;
  /** How many answers are being held. */
  size(): number;
  /** Throw everything away. */
  clear(): void;
  /** Diagnostics: how often a lookup was already answered. */
  stats(): { hits: number; misses: number };
}

/**
 * Bounded so that paging through a year of months cannot grow without limit.
 * Two hundred is comfortably more than any view asks for at once (the largest
 * is a month grid at forty-two) while staying small enough to be irrelevant.
 */
export const DEFAULT_CACHE_LIMIT = 200;

export function createKeyedCache<V>(
  build: (key: string) => V,
  limit: number = DEFAULT_CACHE_LIMIT,
): KeyedCache<V> {
  const entries = new Map<string, V>();
  let hits = 0;
  let misses = 0;
  const cap = Math.max(1, Math.floor(limit));

  return {
    get(key: string): V {
      if (entries.has(key)) {
        const value = entries.get(key) as V;
        hits += 1;
        // Re-inserting moves it to the end of a Map's iteration order, which is
        // what makes the eviction below least-recently-used rather than
        // least-recently-BUILT. Scrolling back and forth over the same week
        // must not evict that week.
        entries.delete(key);
        entries.set(key, value);
        return value;
      }

      misses += 1;
      const value = build(key);
      entries.set(key, value);

      while (entries.size > cap) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return value;
    },

    size: () => entries.size,
    clear: () => { entries.clear(); hits = 0; misses = 0; },
    stats: () => ({ hits, misses }),
  };
}

/**
 * The key for one day's agenda.
 *
 * `todayKey` is in here rather than in the cache's identity because it changes
 * once a day on its own, with no edit to hang a rebuild off. Including it means
 * the answer for "2026-09-02, asked while today is 2026-09-02" and the answer
 * for "2026-09-02, asked while today is 2026-09-03" are different questions,
 * which is exactly what they are: the first includes undated tasks and the
 * second does not.
 */
export function dayCacheKey(date: string, todayKey: string): string {
  return date === todayKey ? `${date}|today` : date;
}
