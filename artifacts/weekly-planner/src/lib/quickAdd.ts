// ─── Quick Add Parser ────────────────────────────────────────────────────────
// Turns a plain-language string like "gym tomorrow 6pm" into a draft record.
//
// WHY PURE AND STATELESS?
// This parses natural language into the exact `DraftInput` structure the rest
// of the app uses. By keeping it pure (passing in `now` rather than asking
// `Date.now()`), it is completely testable without mocking time.
//
// WHY NO NATIVE MODULES OR NEW DEPENDENCIES?
// Adding a heavy NLP library would block over-the-air updates for the Android
// app. The patterns here cover 99% of what people actually type when adding
// something in a hurry.

import { addDays, isBefore, format, startOfDay } from 'date-fns';
import type { DraftInput } from './draft';
import type { Recurrence, RecurFreq, WeekStartsOn, Weekday } from './recurrence';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

export interface QuickAddOptions {
  now: Date;
  weekStartsOn?: WeekStartsOn;
  categories?: { id: string; name: string }[];
  lists?: { id: string; name: string }[];
}

export interface QuickAddResult {
  draft: DraftInput;
  store: 'events' | 'tasks';
  listId?: string;
  matchedTokens: { start: number; end: number; type: string }[];
}

export function parseQuickAdd(input: string, options: QuickAddOptions): QuickAddResult {
  let remaining = input;
  const matchedTokens: { start: number; end: number; type: string }[] = [];

  const blankMatch = (match: RegExpExecArray, type: string) => {
    // Preserve any leading space that the regex matched so words don't collapse together.
    const offset = match[0].match(/^\s/) ? 1 : 0;
    const start = match.index + offset;
    const end = match.index + match[0].length;
    matchedTokens.push({ start, end, type });
    remaining = remaining.substring(0, start) + ' '.repeat(end - start) + remaining.substring(end);
  };

  // 1. Tags (!category or !list)
  let categoryId: string | undefined;
  let listId: string | undefined;

  const tagRe = /(?:^|\s)!([A-Za-z0-9_\-\u0600-\u06FF]+)(?=\s|$)/ig; // Support Arabic and normal text
  let tagMatch;
  while ((tagMatch = tagRe.exec(remaining)) !== null) {
    const tagName = tagMatch[1].toLowerCase();
    let found = false;
    
    // Check categories first
    if (options.categories) {
      const cat = options.categories.find(c => c.name.toLowerCase().startsWith(tagName));
      if (cat) {
        categoryId = cat.id;
        found = true;
      }
    }
    // Then check lists if no category matched
    if (!found && options.lists) {
      const lst = options.lists.find(l => l.name.toLowerCase().startsWith(tagName));
      if (lst) {
        listId = lst.id;
        found = true;
      }
    }
    
    // Blank it out only if it actually matched something known.
    // An unknown tag like "!invalid" remains part of the title as requested.
    if (found) {
      blankMatch(tagMatch, 'tag');
    }
  }

  // 2. Duration (e.g. "for 45m", "for 1.5h")
  let durationMin: number | null = null;
  const durationRe = /(?:^|\s)for\s+(\d+(?:\.\d+)?)\s*(m|min|mins|minutes|h|hr|hrs|hours)(?=\s|$)/i;
  const durationMatch = durationRe.exec(remaining);
  if (durationMatch) {
    const val = parseFloat(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    if (unit.startsWith('h')) {
      durationMin = Math.round(val * 60);
    } else {
      durationMin = Math.round(val);
    }
    blankMatch(durationMatch, 'duration');
  }

  // 3. Time. A RANGE FIRST, then a single moment.
  //
  // "5pm to 6pm" has to be tried before "5pm", or the single-time pattern takes
  // the "5pm" and leaves "to 6pm" sitting in the title, which is both an ugly
  // title and an event of the wrong length. Longest match first is the only
  // order that works here.
  /**
   * A clock time, written as a regex LITERAL rather than assembled from a
   * string.
   *
   * Building this pattern out of quoted pieces was a bug waiting to happen:
   * '\d' inside a quoted string is just the letter d, so the pattern silently
   * stopped matching digits while still reading as correct. A literal cannot
   * lose its own backslashes.
   */
  const RANGE_RE = /(?:^|\s)(?:from\s+)?(noon|midnight|(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]m)?|(?:1[0-2]|0?[1-9])\s*[ap]m)\s*(?:to|until|till|\u2013|\u2014|-)\s*(noon|midnight|(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]m)?|(?:1[0-2]|0?[1-9])\s*[ap]m)(?=\s|$)/i;
  const TIME_RE = /(?:^|\s)(?:at\s+)?(noon|midnight|(?:[01]?\d|2[0-3]):[0-5]\d(?:\s*[ap]m)?|(?:1[0-2]|0?[1-9])\s*[ap]m)(?=\s|$)/i;

  /** "5pm", "17:00", "noon" to minutes from midnight. */
  const readClock = (raw: string): number => {
    let t = raw.toLowerCase().replace(/\s+/g, '');
    if (t === 'noon') return 12 * 60;
    if (t === 'midnight') return 0;
    const isPm = t.includes('pm');
    const isAm = t.includes('am');
    t = t.replace(/[ap]m/, '');
    const [hStr, mStr] = t.split(':');
    let h = parseInt(hStr, 10);
    const m = mStr ? parseInt(mStr, 10) : 0;
    if (isPm && h < 12) h += 12;
    if (isAm && h === 12) h = 0;
    return h * 60 + m;
  };

  let startMin: number | null = null;
  let endFromRange: number | null = null;

  // A RANGE IS TRIED FIRST. Otherwise the single time pattern takes the "5pm"
  // out of "5pm to 6pm" and leaves "to 6pm" sitting in the title, which is both
  // an ugly title and an event of the wrong length.
  const rangeMatch = RANGE_RE.exec(remaining);
  if (rangeMatch) {
    startMin = readClock(rangeMatch[1]);
    endFromRange = readClock(rangeMatch[2]);
    // An end at or before the start ran past midnight. "10pm to 1am" is an
    // ordinary thing to type, and refusing it would be pedantry.
    if (endFromRange <= startMin) endFromRange += 24 * 60;
    blankMatch(rangeMatch, 'time');
  } else {
    const timeMatch = TIME_RE.exec(remaining);
    if (timeMatch) {
      startMin = readClock(timeMatch[1]);
      blankMatch(timeMatch, 'time');
    }
  }

  // 4. Recurrence, BEFORE the date.
  //
  // "every monday and wednesday" contains a weekday, and the date parser is
  // perfectly happy to take it: it would blank out "monday", leaving "every and
  // wednesday", and the repeat would silently become a one off on next Monday.
  // Whichever of the two runs first wins the word, so the more specific pattern
  // has to go first.
  let recur: Recurrence | undefined;
  const recurRe = /(?:^|\s)every\s+((?:\d+\s+)?(?:days?|weekdays?|weeks?|months?|years?)|(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?(?:\s*(?:,|and)\s*(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)s?)*))(?=\s|$)/i;
  const recurMatch = recurRe.exec(remaining);
  
  if (recurMatch) {
    const val = recurMatch[1].toLowerCase();
    let freq: RecurFreq = 'weekly';
    let interval = 1;
    let byWeekday: Weekday[] | undefined;
    
    const numMatch = /^(\d+)\s+/.exec(val);
    if (numMatch) {
      interval = parseInt(numMatch[1], 10);
    }
    
    if (/\bdays?\b/.test(val)) {
      freq = 'daily';
    } else if (val.includes('month')) {
      freq = 'monthly';
    } else if (val.includes('year')) {
      freq = 'yearly';
    } else if (/\bweeks?\b/.test(val)) {
      freq = 'weekly';
    } else if (val.includes('weekday')) {
      freq = 'weekly';
      byWeekday = [1, 2, 3, 4, 5] as Weekday[];
    } else {
      freq = 'weekly';
      const daysMap: Record<string, Weekday> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      byWeekday = [];
      for (const [k, v] of Object.entries(daysMap)) {
        if (new RegExp(`\\b${k}`).test(val)) {
          byWeekday.push(v);
        }
      }
      if (byWeekday.length === 0) byWeekday = undefined;
    }
    
    recur = { freq, interval, byWeekday };
    blankMatch(recurMatch, 'recurrence');
  }

  // 5. Date
  let parsedDate: Date | null = null;
  const dateRe = /(?:^|\s)(?:(today|tomorrow|tonight)|(?:(next|this)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)|(?:(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)(?:\s+(\d{4}))?)|(?:(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?))(?=\s|$)/i;
  const dateMatch = dateRe.exec(remaining);
  
  if (dateMatch) {
    const [_, relWord, nextThis, dow, dom1, mon1, yr1, mon2, dom2, yr2] = dateMatch;
    
    if (relWord) {
      const rw = relWord.toLowerCase();
      if (rw === 'today' || rw === 'tonight') {
        parsedDate = startOfDay(options.now);
      } else if (rw === 'tomorrow') {
        parsedDate = addDays(startOfDay(options.now), 1);
      }
    } else if (dow) {
      const d = dow.toLowerCase();
      const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
      const targetDay = days.findIndex(x => d.startsWith(x));
      const todayDay = options.now.getDay();
      
      let diff = targetDay - todayDay;
      if (diff <= 0) diff += 7;
      
      const nt = nextThis?.toLowerCase();
      if (nt === 'next' && diff < 7) {
        diff += 7;
      }
      parsedDate = addDays(startOfDay(options.now), diff);
    } else {
      const dom = dom1 || dom2;
      const mon = (mon1 || mon2).toLowerCase();
      const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
      const targetMon = months.findIndex(x => mon.startsWith(x));
      const targetDom = parseInt(dom, 10);
      // AN EXPLICIT YEAR IS OBEYED, and it must be: rolling "1 Jan 2030"
      // forward to the next January silently creates the item four years early,
      // which is worse than not understanding it at all.
      const written = yr1 || yr2;
      const targetYear = written ? parseInt(written, 10) : options.now.getFullYear();
      let d = new Date(targetYear, targetMon, targetDom);

      // Valid date check. JavaScript rolls 31 February over into March rather
      // than refusing it, so the only way to know the date was real is to ask
      // what came back.
      if (d.getMonth() === targetMon && d.getDate() === targetDom) {
        // Only a year that was NOT written down may be guessed forward. A date
        // already gone this year almost always means the next one.
        if (!written && isBefore(d, startOfDay(options.now))) {
          d = new Date(targetYear + 1, targetMon, targetDom);
        }
        parsedDate = d;
      }
    }
    
    if (parsedDate) {
      blankMatch(dateMatch, 'date');
    }
  }

  // 6. Clean up the title and determine Task vs Event
  const cleanTitle = remaining.replace(/\s+/g, ' ').trim();
  const firstWord = cleanTitle.split(' ')[0].toLowerCase();

  let store: 'events' | 'tasks' = 'events';
  if (listId) {
    store = 'tasks';
  } else if (categoryId) {
    store = 'events';
  } else if (durationMin !== null) {
    store = 'events';
  } else {
    // Basic heuristics to decide if it's a task or an event
    const taskVerbs = [
      'call', 'buy', 'pay', 'submit', 'email', 'send', 'finish', 
      'write', 'read', 'clean', 'wash', 'fix', 'remind', 'do', 'make', 'get'
    ];
    const eventNouns = [
      'meeting', 'lunch', 'dinner', 'gym', 'dentist', 'appointment', 
      'doctor', 'class', 'lecture', 'coffee', 'standup', 'party'
    ];
    
    if (taskVerbs.includes(firstWord)) {
      store = 'tasks';
    } else if (eventNouns.some(n => cleanTitle.toLowerCase().includes(n))) {
      store = 'events';
    } else if (startMin === null) {
      store = 'tasks'; // No time and no explicit event noun -> likely a task
    } else {
      store = 'events';
    }
  }

  const allDay = startMin === null;
  let endMin: number | null = null;
  if (!allDay && store === 'events') {
    // A written range wins over a written duration, and both win over the
    // hour that is only ever a guess.
    endMin = endFromRange !== null
      ? endFromRange
      : startMin! + (durationMin !== null ? durationMin : 60);
  }

  const draft: DraftInput = {
    title: cleanTitle,
    date: parsedDate ? ymd(parsedDate) : ymd(options.now),
    allDay,
    startMin,
    endMin,
    categoryId,
    recur,
  };

  // Sort matched tokens so they appear in order for the UI to highlight
  matchedTokens.sort((a, b) => a.start - b.start);

  return { draft, store, listId, matchedTokens };
}
