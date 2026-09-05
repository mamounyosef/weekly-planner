// ─── Focus, as numbers ───────────────────────────────────────────────────────
// The arithmetic behind the focus screen, kept apart from `focusSessions.ts`.
//
// WHY A SEPARATE MODULE. `focusSessions.ts` is where the chimes live: a thousand
// lines of Web Audio, `localStorage` coordination between the two desktop
// windows, and `crypto.randomUUID`. None of that exists on a phone, and none of
// it is needed to add up how long someone worked. Copying that file across to
// get three sums would drag a browser's worth of assumptions into a React Native
// bundle.
//
// So the maths lives here, pure and shared, and both machines total the same
// history the same way. A phone that disagreed with the PC about yesterday would
// be worse than a phone that showed nothing.

/** Exactly the shape the sessions file stores. */
export interface FocusSessionRecord {
  id: string;
  startedAt: string;
  endedAt?: string;
  durationSeconds: number;
  plannedSeconds?: number;
}

/**
 * THE ID OF A SESSION IS THE MOMENT IT BEGAN. Nothing else.
 *
 * A session can be ended in four different ways -- it runs out on the PC, it
 * runs out on the phone, you stop it by hand, or it is reconstructed after the
 * machine was switched off -- and each of those used to mint its own id:
 *
 *     auto-<start>-<planned>      the countdown reaching zero
 *     stop-<start>-<duration>     a hand stop
 *     recovered-<start>           a ghost rebuilt on the next launch
 *
 * The deduplication that was supposed to collapse two records of one session
 * compared ids, so it only ever worked when both ends agreed on the SPELLING.
 * They routinely do not: the PC's countdown hit zero and wrote `auto-...-3600`
 * while the phone stopped the same session and wrote `stop-...-3510`, and the
 * hour was counted twice. Nine sessions in this database were logged twice that
 * way, inventing eight hours.
 *
 * The duration and the planned length are exactly the things two machines
 * disagree about, so neither belongs in an identity. The start does not change,
 * whoever is looking, which makes it the only honest key.
 */
export function focusSessionId(sessionStartedAt: string | null, endedAtIso?: string): string {
  if (typeof sessionStartedAt === 'string' && sessionStartedAt.length > 0) {
    return `session-${sessionStartedAt}`;
  }
  // No start recorded. Falling back to a CONSTANT would collapse every such
  // session into one row, silently deleting work, so the end is used instead --
  // still deterministic for the same record, still distinct between records.
  if (typeof endedAtIso === 'string' && endedAtIso.length > 0) {
    return `session-end-${endedAtIso}`;
  }
  return `session-unknown-${Date.now()}`;
}

/**
 * The same session, however it was spelled.
 *
 * Records written before the change above are still in everyone's history, so
 * the three old prefixes are folded onto the new key rather than left to be
 * counted twice forever. `manual-` is deliberately NOT folded: it is a typed
 * day total, not a session, and two of them on one day are two separate facts
 * (which is its own bug, handled where they are written).
 */
export function normaliseFocusSessionId(id: string): string {
  if (typeof id !== 'string' || id.length === 0) return '';
  if (id.startsWith('session-')) return id;

  // `recovered-<startIso>`
  let m = /^recovered-(.+)$/.exec(id);
  if (m) return `session-${m[1]}`;
  // `auto-<startIso>-<plannedSeconds>` and `stop-<startIso>-<durationSeconds>`,
  // where the trailing number is the part the two machines disagree about.
  m = /^(?:auto|stop)-(.+)-\d+$/.exec(id);
  if (m) return `session-${m[1]}`;
  // Same two prefixes from a build that wrote no trailing number.
  m = /^(?:auto|stop)-(.+)$/.exec(id);
  if (m) return `session-${m[1]}`;
  return id;
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local calendar date of a moment, as 'yyyy-MM-dd'. */
export function dateKey(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Which focus-day a moment belongs to.
 *
 * A day does not begin at midnight for someone who works late: with a start hour
 * of 3, anything before 03:00 counts toward the previous day, so a session that
 * ran to half past one still lands on the day it felt like. Character-for-
 * character the same rule as the PC's, including using the local calendar rather
 * than a fixed millisecond offset, which is what keeps it right across a
 * daylight-saving change.
 */
export function focusDayKey(value: Date | string, dayStartHour = 0): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return '';
  const shifted = new Date(d);
  if (shifted.getHours() < dayStartHour) shifted.setDate(shifted.getDate() - 1);
  return dateKey(shifted);
}

/** Below this a session is a mis-tap, not work. Matches the PC's threshold. */
export const MIN_COMPLETED_SESSION_SECONDS = 60;

export function isCountable(s: FocusSessionRecord): boolean {
  return Boolean(s)
    && typeof s.durationSeconds === 'number'
    && Number.isFinite(s.durationSeconds)
    && s.durationSeconds >= MIN_COMPLETED_SESSION_SECONDS;
}

// ─── One row per session, one row per typed day ─────────────────────────────
//
// THE TWO WAYS THIS HISTORY GREW FALSE HOURS.
//
// 1. ONE SESSION, SEVERAL NAMES. A session can be ended in four ways: the
//    countdown runs out on the PC, it runs out on the phone, you stop it by
//    hand, or it is rebuilt after the machine was switched off. Each of those
//    minted its own id -- `auto-<start>-<planned>`, `stop-<start>-<duration>`,
//    `recovered-<start>` -- and the deduplication that was meant to collapse
//    them compared ids, so it only worked when both ends happened to spell it
//    the same way. They routinely did not: the PC wrote `auto-...-3600` for an
//    hour the phone had already stopped as `stop-...-3510`, and the hour was
//    counted twice.
//
// 2. ONE DAY, SEVERAL TYPED TOTALS. Editing a day's total writes a
//    `manual-<day>-<stamp>-<seconds>` row and deletes that day's other rows.
//    The delete could be undone (see the save route), so editing the same day
//    twice left BOTH typed totals in place and the day reported their sum.
//
// Both are fixed at the point they are written, but the rows already on disk
// are still there, so this collapses them on the way in. It is a pure function
// of the list, which means the charts stop lying immediately, before any repair
// is run and without either machine having to agree to it first.

/** The last of these wins when the same day was typed in more than once. */
function manualStampOf(id: string): number | null {
  const m = /^manual-(\d{4}-\d{2}-\d{2})-(\d+)-/.exec(id);
  return m ? Number(m[2]) : null;
}

/** The day a typed total was typed FOR, taken from its own id. */
function manualDayOf(id: string): string | null {
  const m = /^manual-(\d{4}-\d{2}-\d{2})-/.exec(id);
  return m ? m[1] : null;
}

/**
 * How much a record's own timestamps agree with the duration it claims.
 *
 * A paused session legitimately spans longer than it ran, so a longer span is
 * not evidence of anything. A span SHORTER than the duration is impossible, and
 * marks a record whose endpoints were reconstructed badly -- given two records
 * of one session, prefer the one that is at least self-consistent.
 */
function isCoherent(s: FocusSessionRecord): boolean {
  if (!s.endedAt || !s.startedAt) return false;
  const a = Date.parse(s.startedAt);
  const b = Date.parse(s.endedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return (b - a) / 1000 >= s.durationSeconds - 2;
}

/**
 * Which of two records of the SAME session to believe.
 *
 * THE SHORTER ONE, and deliberately so. This function exists because hours were
 * invented; when the two ends disagree, the reading that does not invent is the
 * honest one. A hand stop at 58:30 and an auto-completion at 60:00 are the same
 * hour, and the ninety seconds are not worth the risk of keeping the larger
 * figure every time a race happens. Coherence breaks a tie, so a record whose
 * own timestamps make sense beats one whose do not.
 */
function betterOf<T extends FocusSessionRecord>(a: T, b: T): T {
  if (a.durationSeconds !== b.durationSeconds) {
    return a.durationSeconds < b.durationSeconds ? a : b;
  }
  const ca = isCoherent(a);
  const cb = isCoherent(b);
  if (ca !== cb) return ca ? a : b;
  // Nothing to choose between them: keep the earlier-started one so the result
  // does not depend on the order the list happened to arrive in.
  return String(a.startedAt) <= String(b.startedAt) ? a : b;
}

/**
 * Collapse a history to one row per session and one typed total per day.
 *
 * Order is preserved: each surviving row stays where its first occurrence was,
 * so a list that was already sorted stays sorted and nothing appears to jump.
 */
export function dedupeFocusHistory<T extends FocusSessionRecord>(
  sessions: readonly T[],
): T[] {
  if (!Array.isArray(sessions) || sessions.length === 0) return [];

  const order: string[] = [];
  const chosen = new Map<string, T>();

  for (const s of sessions) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || s.id === '') continue;

    const day = manualDayOf(s.id);
    // A typed total is keyed by the DAY it was typed for, so a second edit of
    // the same day replaces the first instead of adding to it.
    const key = day !== null ? `manual:${day}` : normaliseFocusSessionId(s.id);

    const existing = chosen.get(key);
    if (!existing) {
      chosen.set(key, s);
      order.push(key);
      continue;
    }

    if (day !== null) {
      // For typed totals the LAST edit is what the user meant, not the smallest.
      // They are corrections, not two observations of one thing.
      const stampNew = manualStampOf(s.id) ?? 0;
      const stampOld = manualStampOf(existing.id) ?? 0;
      if (stampNew >= stampOld) chosen.set(key, s);
      continue;
    }

    chosen.set(key, betterOf(existing, s));
  }

  return order.map(k => chosen.get(k)!).filter(Boolean);
}

/**
 * What collapsing the history would change, without changing it.
 *
 * For the repair tool and for the diagnostics screen: a number nobody can check
 * is not evidence, and "your Tuesday says thirty hours" deserves an answer that
 * names the rows.
 */
export function focusHistoryDuplicates(
  sessions: readonly FocusSessionRecord[],
): { removed: FocusSessionRecord[]; secondsRemoved: number } {
  const kept = new Set(dedupeFocusHistory(sessions).map(s => s.id));
  const removed = (sessions ?? []).filter(s => s && typeof s.id === 'string' && !kept.has(s.id));
  return {
    removed,
    secondsRemoved: removed.reduce((sum, s) => sum + (Number(s.durationSeconds) || 0), 0),
  };
}

export interface FocusDay {
  date: string;
  seconds: number;
  sessions: number;
}

export interface FocusSummary {
  /** Oldest first, one entry per day in the range, including empty days. */
  days: FocusDay[];
  totalSeconds: number;
  sessions: number;
  /** Mean over days that had ANY focus, not over the whole range — an average
   *  diluted by days off says nothing about how a working day actually goes. */
  averageSeconds: number;
  bestDay: FocusDay | null;
  /** Consecutive days with focus, counting back from the end of the range. */
  streak: number;
}

/** Every date from `from` to `to` inclusive, as keys. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return out;
  const cursor = new Date(start);
  // Guarded rather than trusted: a reversed or absurd range would otherwise spin
  // forever building an array nobody asked for.
  for (let i = 0; cursor <= end && i < 3660; i += 1) {
    out.push(dateKey(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Total a history over a range of days.
 *
 * Days with nothing are included deliberately: a chart with the gaps missing
 * reads as continuous work, which is a flattering lie.
 */
export function summariseFocus(
  sessions: readonly FocusSessionRecord[],
  opts: { from: string; to: string; dayStartHour?: number; excludedDates?: string[] },
): FocusSummary {
  const dayStartHour = opts.dayStartHour ?? 0;
  const excluded = new Set(opts.excludedDates ?? []);
  const totals = new Map<string, { seconds: number; sessions: number }>();

  // Collapsed FIRST, then corrections applied. Two records of one session, two
  // typed totals for one day, and a typed total sitting on top of the sessions
  // it was meant to replace are the three ways a day came to report thirty
  // hours; all three are answered before anything is added up.
  for (const s of applyTypedDayTotals(dedupeFocusHistory(sessions ?? []), dayStartHour)) {
    if (!isCountable(s)) continue;
    // Bucketed by when it ENDED. A session that starts before the cutoff and
    // ends after it belongs to the day it was finished in, which is how the PC
    // credits it and how a person remembers it.
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    if (!key || key < opts.from || key > opts.to) continue;
    const entry = totals.get(key) ?? { seconds: 0, sessions: 0 };
    entry.seconds += s.durationSeconds;
    entry.sessions += 1;
    totals.set(key, entry);
  }

  const days: FocusDay[] = dateRange(opts.from, opts.to).map(date => {
    const entry = totals.get(date);
    return { date, seconds: entry?.seconds ?? 0, sessions: entry?.sessions ?? 0 };
  });

  const worked = days.filter(d => d.seconds > 0);
  const totalSeconds = worked.reduce((sum, d) => sum + d.seconds, 0);
  const sessionCount = worked.reduce((sum, d) => sum + d.sessions, 0);

  let bestDay: FocusDay | null = null;
  for (const d of days) if (!bestDay || d.seconds > bestDay.seconds) bestDay = d;
  if (bestDay && bestDay.seconds === 0) bestDay = null;

  let streak = 0;
  for (let i = days.length - 1; i >= 0; i -= 1) {
    if (days[i].seconds <= 0) {
      if (excluded.has(days[i].date)) {
        continue;
      }
      break;
    }
    streak += 1;
  }

  return {
    days,
    totalSeconds,
    sessions: sessionCount,
    averageSeconds: worked.length > 0 ? Math.round(totalSeconds / worked.length) : 0,
    bestDay,
    streak,
  };
}

export interface FocusStreaks {
  currentStreak: number;
  longestStreak: number;
}

export function computeAllTimeStreaks(
  sessions: readonly FocusSessionRecord[],
  opts: { anchorDate: Date; dayStartHour?: number; excludedDates?: string[] },
): FocusStreaks {
  const dayStartHour = opts.dayStartHour ?? 0;
  const excluded = new Set(opts.excludedDates ?? []);
  
  const byDaySeconds = new Map<string, number>();
  // The same two rules the week totals apply. A chart that disagrees with the
  // number beside it is worse than either being wrong on its own.
  for (const s of applyTypedDayTotals(dedupeFocusHistory(sessions ?? []), dayStartHour)) {
    if (!isCountable(s)) continue;
    const key = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    if (!key) continue;
    byDaySeconds.set(key, (byDaySeconds.get(key) ?? 0) + s.durationSeconds);
  }

  const activeDayKeys = new Set(
    Array.from(byDaySeconds.entries())
      .filter(([k, secs]) => secs > 0 && !excluded.has(k))
      .map(([k]) => k)
  );

  let currentStreak = 0;
  {
    let cursorDate = new Date(`${focusDayKey(opts.anchorDate, dayStartHour)}T00:00:00`);
    let maxLookback = 1000;
    while (maxLookback-- > 0) {
      const k = dateKey(cursorDate);
      if (excluded.has(k)) {
        cursorDate = new Date(cursorDate.getTime() - 86400000);
        continue;
      }
      if (activeDayKeys.has(k)) {
        currentStreak++;
        cursorDate = new Date(cursorDate.getTime() - 86400000);
      } else {
        break;
      }
    }
  }

  let longestStreak = 0;
  let run = 0;
  let prevDate: Date | null = null;
  const sortedActiveKeys = Array.from(activeDayKeys).sort();
  for (const k of sortedActiveKeys) {
    const d = new Date(`${k}T00:00:00`);
    if (!prevDate) {
      run = 1;
    } else {
      let gapDate = new Date(prevDate.getTime() + 86400000);
      let validGapDays = 0;
      while (gapDate < d) {
        if (!excluded.has(dateKey(gapDate))) {
          validGapDays++;
        }
        gapDate = new Date(gapDate.getTime() + 86400000);
      }
      if (validGapDays === 0) {
        run++;
      } else {
        run = 1;
      }
    }
    if (run > longestStreak) longestStreak = run;
    prevDate = d;
  }

  return { currentStreak, longestStreak };
}

/** "2h 15m", "45m", "None". Short enough to sit under a bar on a phone. */
export function describeDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'None';
  const mins = Math.round(seconds / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Fold one client's history into what the server already holds.
 *
 * THE UNION IS DELIBERATE, AND THE HOLE IN IT WAS NOT. Two windows and a phone
 * each hold their own copy of this list, so a client saving a list it loaded a
 * minute ago must not wipe a session another one has logged since. Keeping
 * every stored row the sender did not mention is what protects that.
 *
 * But it also made deletion impossible. Correcting a day's total removes that
 * day's rows and writes one typed total in their place -- and the removals were
 * put straight back by the next save from any other window. The typed total
 * then sat on top of the sessions it was meant to replace, and correcting the
 * same day again added a second typed total beside the first. That is the whole
 * of how one Tuesday came to claim thirty hours and twenty minutes.
 *
 * Absence cannot mean "delete this" while it also means "I had not heard of
 * it". So a sender may now say what it deliberately removed: named rows are
 * dropped, merely-absent rows are kept, and the two are never confused.
 */
export function foldFocusSessions(
  stored: readonly FocusSessionRecord[],
  incoming: readonly FocusSessionRecord[],
  removedIds: readonly string[] = [],
): FocusSessionRecord[] {
  const dropped = new Set(removedIds ?? []);
  const byId = new Map<string, FocusSessionRecord>();

  // Stored first, then incoming, so the sender's version of a row it does know
  // about (an edited duration, say) wins over the copy on disk.
  for (const list of [stored ?? [], incoming ?? []]) {
    for (const row of list) {
      if (!row || typeof row !== 'object') continue;
      if (typeof row.id !== 'string' || row.id === '') continue;
      if (dropped.has(row.id)) continue;
      byId.set(row.id, row);
    }
  }

  // Collapsed on the way out as well as on the way in: a phone and a PC that
  // ended the same session independently wrote two rows under two different
  // ids, and this is where those stop reaching anybody's chart.
  return dedupeFocusHistory([...byId.values()])
    .sort((a, b) => String(b.endedAt ?? '').localeCompare(String(a.endedAt ?? '')));
}

/**
 * A typed day total REPLACES the day it was typed for, up to the moment it was
 * typed.
 *
 * WHAT THE EDIT ACTUALLY MEANS. Correcting a day's figure is not "add this to
 * what is already there", it is "that day was nine hours". The write side has
 * always understood that -- it deletes the day's rows and puts one typed total
 * in their place -- but the deletion could be undone (see `foldFocusSessions`),
 * and once the sessions were back the typed total simply sat on top of them.
 * The Tuesday that reported thirty hours was nine hours typed twice PLUS the
 * eleven hours of real sessions it was supposed to stand in for.
 *
 * Collapsing the duplicate typed totals is not enough on its own: nine hours
 * plus the sessions is still seventeen. So the rule is applied on READ as well,
 * which is what makes a database nobody has repaired show the right number.
 *
 * UP TO THE MOMENT IT WAS TYPED, and no further. The stamp is in the row's own
 * id, so a session logged AFTER the correction is work done after it and is
 * kept -- type a total at noon, work three more hours, and the day is the total
 * plus three hours. Anything else would make a day uncorrectable for the rest
 * of its life.
 */
export function applyTypedDayTotals<T extends FocusSessionRecord>(
  sessions: readonly T[],
  dayStartHour = 0,
): T[] {
  const rows = sessions ?? [];

  // The newest correction for each day, by the stamp in its own id.
  const typedAt = new Map<string, number>();
  for (const s of rows) {
    if (!s || typeof s.id !== 'string') continue;
    const day = manualDayOf(s.id);
    if (day === null) continue;
    const stamp = manualStampOf(s.id) ?? 0;
    if (stamp >= (typedAt.get(day) ?? -1)) typedAt.set(day, stamp);
  }
  if (typedAt.size === 0) return rows as T[];

  return rows.filter(s => {
    if (!s || typeof s.id !== 'string') return false;
    // A typed total is never dropped by this rule; duplicates between two of
    // them are `dedupeFocusHistory`'s business, not this one's.
    if (manualDayOf(s.id) !== null) return true;

    const day = focusDayKey(s.endedAt ?? s.startedAt, dayStartHour);
    const stamp = typedAt.get(day);
    if (stamp === undefined) return true; // no correction for this day

    // Logged after the correction was made, so it is work the correction could
    // not have known about.
    const endedMs = Date.parse(s.endedAt ?? s.startedAt ?? '');
    if (!Number.isFinite(endedMs)) return false;
    return endedMs > stamp;
  });
}
