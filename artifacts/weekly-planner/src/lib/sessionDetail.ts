// The arithmetic behind the sessions-detail page (Focus → any "N sessions"
// count → one day or one week of individual sessions).
//
// Kept pure and away from the page on purpose: every rule here is a way the
// page could lie to somebody, and each one has a test.
//
//   MANUAL ENTRIES HAVE NO CLOCK. Editing a day's total ("Modify Focus Time")
//   stores one synthetic session anchored at the day-start hour — a 10-minute
//   edit made at noon reads startedAt 4:00 AM when the day starts at 4. The
//   duration is real; the times are a storage detail, never a claim about when
//   anybody worked. `isManual` is what stops the page from presenting that
//   anchor as a real start time, and keeps it out of "first start"/"last end"
//   and off the day map, where it would sit at 4 AM looking like a session
//   nobody started.
//
//   GAPS ARE ONLY MEASURED BETWEEN REAL SESSIONS. A manual entry's fake 4 AM
//   end must never manufacture a "5h 50m break before" chip under a 10 AM
//   session, so the gap chain simply skips manual entries.
//
//   THE DAY A SESSION BELONGS TO is the focus-day of its END, using the same
//   configurable day-start hour as every other screen, so a session ending at
//   2 AM with a 4 AM day start appears on yesterday's page.

import {
  MIN_COMPLETED_SESSION_SECONDS,
  focusDayKey,
  type FocusSession,
} from './focusSessions';

/** True when the session is a typed day total rather than a timed session. */
export function isManualFocusSession(session: FocusSession): boolean {
  return typeof session.id === 'string' && session.id.startsWith('manual-');
}

export interface SessionDetailMatch {
  session: FocusSession;
  /** Position of this match within the whole result — timeline numbering. */
  index: number;
  startMs: number;
  endMs: number;
  /** Seconds the session actually ran (what the day total counts). */
  actual: number;
  /** Seconds the session was planned to run. Equals `actual` for manual rows. */
  planned: number;
  /** Typed day total — no real start/end time exists. */
  isManual: boolean;
  /** Meets the same 20-minute bar the analysis session counts use. */
  countsAsComplete: boolean;
  /** Seconds since the previous REAL session ended; null when unknowable. */
  gapBeforeSeconds: number | null;
  /** Started and ended on different calendar days. */
  crossesMidnight: boolean;
  /** Day mode: the start lands on a different calendar day than the viewed one. */
  startsOtherDay: boolean;
  /** Day mode: the end lands on a different calendar day than the viewed one. */
  endsOtherDay: boolean;
}

export interface SessionDetailGroup {
  key: string;
  matches: SessionDetailMatch[];
  seconds: number;
}

export interface SessionDetailResult {
  /** Every session logged to the range, sorted by start time. */
  matches: SessionDetailMatch[];
  /** Week mode only: per-day groups in day order, days with nothing omitted. */
  groups: SessionDetailGroup[];
  /** All seconds, manual included — matches what the day total shows. */
  totalSeconds: number;
  /** Seconds from real (timed) sessions only. */
  realSeconds: number;
  /** Seconds from manual entries only. */
  manualSeconds: number;
  manualCount: number;
  /** Planned seconds of REAL sessions — a manual row's "plan" is just its total. */
  totalPlannedSeconds: number;
  longestSeconds: number;
  avgSeconds: number;
  /** First real start / last real end, ms. Null when only manual (or nothing). */
  firstStartMs: number | null;
  lastEndMs: number | null;
}

function dateKeyOf(ms: number): string {
  const d = new Date(ms);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/**
 * Collate the sessions of one focus day (one entry in `days`) or one whole week
 * (seven entries). `days` are ordered `YYYY-MM-DD` keys; a single entry means
 * day mode, which is the only mode where the starts/ends-other-day badges make
 * sense.
 */
export function buildSessionDetail(
  sessions: FocusSession[],
  days: string[],
  dayStartHour = 0,
): SessionDetailResult {
  const daySet = new Set(days);
  const anchorKey = days.length === 1 ? days[0] : null;

  // Collect and sort FIRST, then derive: the gap chain and the "other day"
  // badges both need the neighbours in start order, whatever order the
  // history arrived in.
  type Row = { session: FocusSession; startMs: number; endMs: number; actual: number };
  const rows: Row[] = [];
  for (const s of sessions) {
    const actual = Math.floor(Number(s.durationSeconds));
    // A zero/negative/NaN duration (or unparsable stamp) is corrupt data from
    // an old import — dropped rather than shown as a 0-minute session.
    if (!Number.isFinite(actual) || actual <= 0) continue;
    const startMs = Date.parse(s.startedAt);
    const endMs = Date.parse(s.endedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    if (!daySet.has(focusDayKey(s.endedAt, dayStartHour))) continue;
    rows.push({ session: s, startMs, endMs, actual });
  }
  rows.sort((a, b) =>
    a.startMs - b.startMs ||
    a.endMs - b.endMs ||
    String(a.session.id).localeCompare(String(b.session.id)),
  );

  const matches: SessionDetailMatch[] = [];
  let lastRealEndMs: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const isManual = isManualFocusSession(r.session);
    // Manual rows sit in the timeline but exit the gap chain both ways: their
    // own fake times would invent a break, and so would measuring from them.
    const gapBeforeSeconds = !isManual && lastRealEndMs != null
      ? Math.max(0, Math.floor((r.startMs - lastRealEndMs) / 1000))
      : null;
    if (!isManual) lastRealEndMs = r.endMs;
    matches.push({
      session: r.session,
      index: i,
      startMs: r.startMs,
      endMs: r.endMs,
      actual: r.actual,
      planned: Math.max(0, Math.floor(Number(r.session.plannedSeconds) || 0)),
      isManual,
      countsAsComplete: r.actual >= MIN_COMPLETED_SESSION_SECONDS,
      gapBeforeSeconds,
      crossesMidnight: dateKeyOf(r.startMs) !== dateKeyOf(r.endMs),
      startsOtherDay: anchorKey != null && dateKeyOf(r.startMs) !== anchorKey,
      endsOtherDay: anchorKey != null && dateKeyOf(r.endMs) !== anchorKey,
    });
  }

  const realMatches = matches.filter(m => !m.isManual);
  const totalSeconds = matches.reduce((sum, m) => sum + m.actual, 0);
  const realSeconds = realMatches.reduce((sum, m) => sum + m.actual, 0);
  const manualSeconds = totalSeconds - realSeconds;

  const groups: SessionDetailGroup[] = days.length > 1
    ? days
        .map(key => {
          const dayMatches = matches.filter(m => focusDayKey(m.session.endedAt, dayStartHour) === key);
          return { key, matches: dayMatches, seconds: dayMatches.reduce((s, m) => s + m.actual, 0) };
        })
        .filter(g => g.matches.length > 0)
    : [];

  return {
    matches,
    groups,
    totalSeconds,
    realSeconds,
    manualSeconds,
    manualCount: matches.length - realMatches.length,
    totalPlannedSeconds: realMatches.reduce((sum, m) => sum + m.planned, 0),
    longestSeconds: matches.reduce((b, m) => Math.max(b, m.actual), 0),
    avgSeconds: matches.length > 0 ? Math.round(totalSeconds / matches.length) : 0,
    firstStartMs: realMatches.length > 0 ? realMatches[0].startMs : null,
    lastEndMs: realMatches.length > 0 ? realMatches[realMatches.length - 1].endMs : null,
  };
}

// ── Day map geometry ─────────────────────────────────────────────────────────
// The day map is one horizontal strip running from the day-start hour round to
// the same hour the next day. Positions are LOCAL WALL CLOCK — the strip is a
// picture of the clock, so a 23- or 25-hour daylight-saving day still maps
// 0..100 by the time a person would read off their watch.

/**
 * Where a moment sits on the day map, 0–100. The day-start hour itself is 0;
 * a minute before it (e.g. 3:59 AM on a 4 AM day) is ~99.93, the far right.
 */
export function dayMapPercent(ms: number, dayStartHour: number): number {
  const d = new Date(ms);
  const minutes = d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60;
  const wrapped = (((minutes - dayStartHour * 60) % 1440) + 1440) % 1440;
  return (wrapped / 1440) * 100;
}

/**
 * How wide a session's block is on the day map, in percent — the span between
 * its two `dayMapPercent` positions, adding a full strip when it wraps past
 * the day-start hour (an 11 PM → 1 AM session on a 4 AM day is one 8.33% block
 * near the right edge, not a 71% block wrapping the whole way round).
 */
export function dayMapSpanPercent(startMs: number, endMs: number, dayStartHour: number): number {
  const durationMin = (endMs - startMs) / 60_000;
  if (durationMin >= 1440) return 100;
  if (durationMin <= 0) return 0;
  const s = dayMapPercent(startMs, dayStartHour);
  const e = dayMapPercent(endMs, dayStartHour);
  let width = e - s;
  if (width <= 0) width += 100;
  return width;
}
