/**
 * Saying which update is running, in words rather than in a timestamp.
 *
 * WHY THIS IS NOT JUST toLocaleString
 * The question being asked in Settings is never "what is the exact second this
 * was published". It is "am I running the thing that was just published, or am
 * I still on last week's". A raw stamp answers that only after the reader does
 * arithmetic against the current time, which is exactly the step that made a
 * pinned `runtimeVersion` of 1.0.0 look like a fresh install for months.
 *
 * So there are two halves: WHEN it was published, in the reader's own clock,
 * and HOW LONG AGO that was. The second half is the one that actually answers
 * the question; the first is what lets it be matched against the publish folder
 * on the PC.
 *
 * Everything here is pure and takes `now` as an argument, so the phone, the PC
 * and the tests all agree, and so a screen can re-render it on a timer without
 * anything reaching for a clock behind its back.
 */

export type UpdateClock = '12h' | '24h';

export interface UpdateAge {
  /** "Today at 10:22 am", "Yesterday at 9:04 pm", "2 Sep at 10:22 am". */
  when: string;
  /** "just now", "22 minutes ago", "3 days ago". */
  ago: string;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A count and its noun, singular when it is one. Never "1 minutes ago". */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'} ago`;
}

/** The clock face, honouring the planner's own 12/24 hour setting. */
export function formatClockTime(at: Date, clock: UpdateClock = '12h'): string {
  const h = at.getHours();
  const mm = String(at.getMinutes()).padStart(2, '0');
  if (clock === '24h') return `${String(h).padStart(2, '0')}:${mm}`;
  // Midnight and noon are the two the naive `h % 12` gets wrong, and they are
  // the two most likely to be read as a bug rather than a rounding detail.
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${mm} ${h < 12 ? 'am' : 'pm'}`;
}

/** Whole calendar days between two moments, ignoring the time of day. */
function calendarDaysApart(from: Date, to: Date): number {
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b.getTime() - a.getTime()) / DAY);
}

/**
 * How long ago, in the largest unit that still says something true.
 *
 * A publish that appears to be in the FUTURE is not an error worth showing: the
 * phone's clock and the PC's are never exactly equal, and a few seconds of skew
 * would otherwise print "in -1 minutes". It reads as "just now", which is what
 * it is.
 */
export function describeAge(createdAt: Date, now: Date): string {
  const ms = now.getTime() - createdAt.getTime();
  if (!Number.isFinite(ms) || ms < MINUTE) return 'just now';
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), 'minute');
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');

  const days = calendarDaysApart(createdAt, now);
  if (days < 7) return plural(Math.max(1, days), 'day');
  if (days < 31) return plural(Math.floor(days / 7), 'week');
  if (days < 365) return plural(Math.max(1, Math.floor(days / 30)), 'month');
  return plural(Math.floor(days / 365), 'year');
}

/**
 * When it was published, said the way a person would say it.
 *
 * Today and yesterday are named rather than dated, because those are the two
 * answers that mean "you are current" and "you are one publish behind", and a
 * date makes the reader work that out. The year is only shown once it is not
 * this one, so the common case stays short.
 */
export function describeWhen(createdAt: Date, now: Date, clock: UpdateClock = '12h'): string {
  const time = formatClockTime(createdAt, clock);
  const days = calendarDaysApart(createdAt, now);
  if (days === 0) return `Today at ${time}`;
  if (days === 1) return `Yesterday at ${time}`;
  // A publish dated ahead of the phone is clock skew, not tomorrow. Naming it
  // "Tomorrow" would be the one label that is certainly wrong.
  if (days < 0) return `Today at ${time}`;
  const date = `${createdAt.getDate()} ${MONTHS[createdAt.getMonth()]}`;
  const year = createdAt.getFullYear() === now.getFullYear() ? '' : ` ${createdAt.getFullYear()}`;
  return `${date}${year} at ${time}`;
}

/**
 * Both halves at once, or null when there is nothing to describe.
 *
 * `createdAt` is null on an embedded launch, which is a real state worth its own
 * words rather than a blank row: it is where a phone lands after its data is
 * cleared, running the bundle baked into the APK.
 */
export function describeUpdate(
  createdAt: Date | null | undefined,
  now: Date,
  clock: UpdateClock = '12h',
): UpdateAge | null {
  if (!createdAt || Number.isNaN(createdAt.getTime())) return null;
  return {
    when: describeWhen(createdAt, now, clock),
    ago: describeAge(createdAt, now),
  };
}

/**
 * The publish folder's own name, rebuilt from the manifest date.
 *
 * This is what the update is called on the PC (`database/ota/<runtime>/...`),
 * so it is the string to match against when deciding whether a phone actually
 * picked up a publish. Kept beside the friendly wording rather than instead of
 * it: one is for reading, the other is for checking.
 */
export function updateStamp(createdAt: Date | null | undefined): string | null {
  if (!createdAt || Number.isNaN(createdAt.getTime())) return null;
  const n = (v: number) => String(v).padStart(2, '0');
  const day = `${createdAt.getFullYear()}${n(createdAt.getMonth() + 1)}${n(createdAt.getDate())}`;
  return `${day}-${n(createdAt.getHours())}${n(createdAt.getMinutes())}${n(createdAt.getSeconds())}`;
}
