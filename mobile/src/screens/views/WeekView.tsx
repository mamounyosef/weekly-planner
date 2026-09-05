// ─── Week (and custom) ───────────────────────────────────────────────────────
// A time grid across several days. The same component draws the Custom view,
// because "custom" is only a week with a different number of columns.
//
// THE PROBLEM THIS VIEW HAS, AND HOW IT IS ANSWERED
// Seven columns on a phone gives each day about forty-five points. That is not
// enough for a title, so a block here is a coloured bar with as much text as
// fits, and the day view is one tap away for reading. The PC's own settings
// agree — `seedDeviceSettings` drops a phone to the day view precisely because a
// seven-column week at fifteen-minute resolution is unusable. The week is for
// SHAPE: where the gaps are, which days are heavy, whether Thursday is free.
//
// So it is built to be scanned, not read:
//  • the grid scrolls to the first thing in the week rather than to midnight,
//    because nobody's day starts at 00:00 and eight empty hours is a bad
//    first impression
//  • all-day items sit in a band above the grid, never in it
//  • a tap anywhere in a column opens that day
//
// ─── Dragging ────────────────────────────────────────────────────────────────
// The PC lets you draw an event on the grid and drag one around. The phone now
// does the same, with three gestures, and the whole design is about ONE risk:
// this grid lives inside a vertical ScrollView, and a scroll and a drag are the
// same finger moving in the same direction. Get the negotiation wrong and
// either the page will not scroll or events get created every time it does.
//
// The answer is that nothing is ever claimed on movement alone. Every gesture
// starts with a deliberate quarter-second hold:
//
//   hold on empty space  -> a ghost appears under the thumb; drag it out to
//                           length and release to create
//   hold on a block      -> the block lifts and stays lifted; drag to move it,
//                           sideways too in week and custom views to change
//                           its day
//   drag the lifted grip -> the bottom edge follows the thumb, so the block
//                           changes length rather than position
//
// A hold that never moves and a touch that moves before the hold completes are
// both left alone, so a tap still opens the item and a flick still scrolls the
// grid. While a drag is live the ScrollView is disabled outright, because a
// half-claimed gesture is worse than either outcome.
//
// Two more things worth knowing before changing any of this:
//  • Hit testing is done with ARITHMETIC, not with per-block responders. One
//    responder on the whole grid is what makes a drag able to cross from one
//    day column into another; a responder per block cannot hand a gesture over.
//  • Coordinates are page coordinates minus the grid's own page origin, and
//    that origin moves as the grid scrolls, so the scroll offset is tracked and
//    subtracted. Measuring once at mount and trusting it is the bug where every
//    drop lands an hour off after you have scrolled.
//
// All of the arithmetic (snapping, clamping, which column an x is over) is in
// `../../lib/dragGrid`, tested on the PC side. Nothing here decides a time.

import React, { useMemo, useRef, useEffect, useState, useCallback } from 'react';
import { Animated, PanResponder, Pressable, ScrollView, View } from 'react-native';

import { Text, useTheme } from '../../ui/kit';
import { PRESSED, PRESS_DELAY, TAP_DELAY, radius, space } from '../../theme';
import {
  layoutDay, blockEnd, prayerChipMode,
  type Placeable, type Placed, type PrayerChipMode,
} from '../../lib/grid';
import type { PrayerDrawStyle } from '../../lib/viewPrefs';
import {
  FULL_DAY, clipSpan, hourMarksIn, isMinuteVisible, minuteAtY, normaliseRanges, seamsIn,
  slotsIn,
  splitAcrossWindows, visibleMinutes, windowRanges, yOfMinute, type HourRange,
} from '../../lib/dayWindows';
import {
  columnAtX, createRange, minutesAtY, moveBlock, resizeBlock,
} from '../../lib/dragGrid';
import {
  addDays, blockDurationMinutes, blockLabelPlacement, blockTiming, formatClock,
  minutesLeftAt, type AgendaDay, type AgendaItem, type BlockTiming,
} from '../../lib/agenda';
import { inkOn, inkOpacityOn } from '../../lib/gcalColor';

const RAIL = 48;

/** How long a finger must sit still before the grid takes the gesture over. */
const HOLD_MS = 250;
/** How far it may drift during that hold and still count as holding still. */
const HOLD_SLOP = 8;
/** Movement that starts a drag on an ALREADY lifted block, which needs no hold. */
const LIFTED_SLOP = 6;
/** How close to the bottom edge counts as grabbing the resize grip. */
const GRIP_ZONE = 18;

/*
 * THINGS IN HOURS THIS DEVICE DOES NOT DRAW USED TO BE SQUASHED, and are now
 * listed under the column instead (see `OutsideHours` at the foot of this
 * file). Squashing meant pinning a 22 point stub to the nearest edge of the
 * grid, which kept the item reachable but put it at a time it does not have:
 * on a column running six in the morning to two the next, dawn prayer at 04:19
 * was drawn against the bottom, where it read as a prayer at a quarter to two.
 *
 * A wrong answer is better than a missing one only when it is legible as a
 * wrong answer, and a chip sitting neatly on the 1:45 line is not.
 */

/**
 * How tall one slot is drawn, per snap interval.
 *
 * THE INTERVAL IS THE GRID, not just the editor's step size. Setting it to five
 * minutes and still seeing hour lines is the setting doing nothing, which is
 * exactly what it looked like. So the grid draws a line at every slot, and the
 * hour height follows from the slot height rather than being fixed.
 *
 * Finer intervals get shorter slots or the day becomes a mile long: at five
 * minutes an hour is twelve slots, so a generous slot height would make a
 * working day taller than any phone. These heights keep an hour between about
 * 45 and 130 points, which stays scrollable at every setting.
 */
const SLOT_PX: Record<number, number> = { 5: 14, 10: 16, 15: 19, 30: 29, 60: 48 };

function slotHeight(interval: number): number {
  return SLOT_PX[interval] ?? SLOT_PX[30];
}

/**
 * One thing that falls in an hour this device does not draw.
 *
 * Blocks and prayers arrive here as the same shape on purpose. Under the grid
 * they are the same kind of fact -- something at a time you cannot see -- and
 * giving them one row design means they sort into one list rather than into two
 * that happen to be next to each other.
 */
interface OutsideEntry {
  key: string;
  /** Minutes into the column's own window, which is what decides the order. */
  at: number;
  label: string;
  detail: BlockTiming;
  colour: string;
  done: boolean;
  onPress?: () => void;
}

/** What `layoutDay` is given for each block, with the item carried along. */
interface GridItem extends Placeable {
  id: string;
  isTail?: boolean;
  isHead?: boolean;
  item: AgendaItem;
}

/** The live gesture, as the screen draws it. Null when nothing is being dragged. */
type Drag =
  | { mode: 'create'; date: string; startMin: number; endMin: number }
  | { mode: 'move' | 'resize'; date: string; startMin: number; endMin: number | null; item: AgendaItem };

export function WeekView({
  dates, dayOf, today, nowMin, clock, interval = 30, detailed,
  prayersOn, visibleHours, dayWindow, onMenuItem,
  prayerColour, prayerLabels = true, prayerStyle = 'marker',
  isPrayerDone, onTogglePrayer, onOpenItem, onOpenDay, onCreateRange, onMoveItem,
}: { dayWindow?: { start: number; end: number };
  dates: string[];
  dayOf: (date: string) => AgendaDay;
  today: string;
  nowMin: number | null;
  clock?: string;
  /** Snap interval in minutes. Decides the grid's resolution and its height. */
  interval?: number;
  /** One column: there is room for a title and a time inside each block. */
  detailed?: boolean;
  /** Prayer times for a day, drawn across the grid as markers. */
  prayersOn?: (date: string) => { key: string; label: string; minutes: number }[];
  /**
   * The hours this device chooses to draw, from Settings.
   *
   * A FLOOR AND A CEILING, not the whole answer. The window still stretches for
   * anything outside it, because the alternative is drawing an event above the
   * top of the grid, where it is not clipped so much as simply absent, with
   * nothing on screen to say it was ever there. So the setting decides how much
   * empty day you are willing to look at, and the content decides the rest.
   */
  /**
   * Which hours this device draws. A LIST of stretches, so "everything except
   * the middle of the night" is expressible, which a start and an end was not.
   */
  visibleHours?: HourRange[];
  /** This device's own prayer colour, and whether to name each line. */
  prayerColour?: string;
  prayerLabels?: boolean;
  /** Which of the three shapes this device draws prayers in. */
  prayerStyle?: PrayerDrawStyle;
  /** Whether a prayer has been marked as prayed, and how to flip it. */
  isPrayerDone?: (date: string, key: string) => boolean;
  onTogglePrayer?: (date: string, key: string) => void;
  /**
   * Everything you can do to a block without opening it.
   *
   * A long-press cannot be the trigger here: on this grid a long-press already
   * means "pick this up", and one gesture cannot mean two things. So the menu
   * hangs off the block once it is LIFTED, where a tap has nothing else to do
   * (opening the editor for a block you have just picked up would throw the
   * lift away). Hold it, then tap it.
   */
  onMenuItem?: (item: AgendaItem) => void;
  onOpenItem: (item: AgendaItem) => void;
  onOpenDay: (date: string) => void;
  /** Drawing a new event on empty grid. Absent means the gesture is off. */
  onCreateRange?: (r: { date: string; startMin: number; endMin: number }) => void;
  /** Moving or resizing an existing one. Absent means those gestures are off. */
  onMoveItem?: (m: { item: AgendaItem; date: string; startMin: number; endMin: number | null }) => void;
}) {
  const p = useTheme();
  const scroller = useRef<ScrollView>(null);

  const days = useMemo(() => dates.map(date => {
    const agenda = dayOf(date);
    return {
      date,
      allDay: agenda.allDay.filter(i => i.store === 'events'),
      timed: agenda.timed.filter(i => i.store === 'events' && i.startMin !== null),
      prayers: prayersOn ? prayersOn(date) : [],
    };
  }), [dates, dayOf, prayersOn]);

  // The window of hours worth drawing: from an hour before the earliest thing to
  // an hour after the latest, never less than a working day.
  /**
   * The hours actually drawn, and everything measured from them.
   *
   * THE SETTING IS OBEYED NOW. It used to be a floor that content could
   * override: the grid stretched itself open to include the earliest thing on
   * screen, and since dawn prayer in Amman is around 04:19 that meant the day
   * reopened at 3am every morning however the setting was left. It looked like
   * the setting did nothing, because in practice it did nothing.
   *
   * Anything falling in an hour that is not drawn is not lost. It is counted
   * and offered below, and a tap shows the whole day.
   */
  // The two settings meet here. "The day starts at 6am" decides where a column
  // begins and ends; "visible hours" decides which hours inside it are drawn.
  // Combining them was the missing step: the window was a number that changed
  // nothing, and the grid went on running midnight to midnight.
  const ranges = useMemo(
    () => windowRanges(dayWindow, visibleHours),
    [dayWindow, visibleHours],
  );
  // Nothing overrides the choice any more, not content and not a banner. The
  // hours that are hidden are simply not drawn, and the seam says where.
  const shown = ranges;

  const slot = slotHeight(interval);
  const pxPerHour = slot * (60 / interval);
  const marks = useMemo(() => hourMarksIn(shown), [shown]);
  const gridHeight = visibleMinutes(shown) * (pxPerHour / 60);
  /** The one measurement everything on this grid agrees to use. */
  const yAt = useCallback(
    (minute: number) => yOfMinute(minute, shown, pxPerHour),
    [shown, pxPerHour],
  );
  const seams = useMemo(() => seamsIn(shown), [shown]);

  const dayStartH = dayWindow?.start ?? 0;
  /**
   * A clock minute placed on THIS grid.
   *
   * Two in the morning on a day that opens at six is late in the column, not
   * early in it, so it is read as 26:00. Everything the grid draws by time goes
   * through here: the now line, the scroll target, the prayer markers.
   */
  const inWindow = useCallback(
    (minute: number) => (minute < dayStartH * 60 ? minute + 1440 : minute),
    [dayStartH],
  );

  const anyAllDay = days.some(d => d.allDay.length > 0);

  /** Every slot line in the drawn hours, in minutes from midnight. */
  const slots = useMemo(() => slotsIn(shown, interval), [shown, interval]);

  // Laid out HERE rather than inside each column, because the gesture hit-tests
  // blocks by arithmetic and needs to see every day's placement at once. The
  // columns are handed the result so nothing is computed twice.

  const laidOutByDate = useMemo(() => {
    const logicalCols: GridItem[][] = days.map(() => []);
    for (let c = 0; c < days.length; c++) {
      for (const item of days[c].timed) {
        // Where this actually gets drawn, once a night that runs over the end
        // of its column is cut in two. Tested in `dayWindows.test.ts`, because
        // the arithmetic is fiddly and getting it wrong is invisible until a
        // whole night silently shrinks to a sliver.
        const pieces = splitAcrossWindows(item, {
          col: c, columns: days.length, dayStartHour: dayStartH,
        });
        for (const piece of pieces) {
          logicalCols[piece.col].push({
            id: piece.isTail ? `${item.id}_tail` : piece.isHead ? `${item.id}_head` : item.id,
            startMin: piece.startMin,
            endMin: piece.endMin,
            item,
            isTail: piece.isTail,
            isHead: piece.isHead,
          });
        }
      }
    }

    // Every piece pushed above already carries the coordinates of the SEGMENT
    // it is, inside this column's own window. So the top and the height are
    // read straight off it: re-deriving them from the original event is what
    // put a head half a day above its own column.
    return logicalCols.map(colItems => {
      return layoutDay<GridItem>(colItems, { pxPerHour, dayStartHour: dayStartH })
        .map(pl => {
          const segStart = pl.item.startMin;
          const segEnd = blockEnd(pl.item);
          const isTail = pl.item.isTail === true;
          const isHead = pl.item.isHead === true;
          // Three answers, not two. A block can be absent from the drawn
          // hours entirely, or present but cut at one end, and the second case
          // used to be silent: a night from half past midnight to nine, on a
          // grid that stops at two, was drawn as an hour and a half of sleep
          // with nothing to say the other seven existed.
          //
          // Hidden is judged on the WHOLE span now, not on the start alone.
          // Something beginning in an hour that is not drawn and running into
          // one that is used to become a stub, throwing away the part of it
          // there was room for.
          const clip = clipSpan(segStart, segEnd, shown);

          const at = yAt(segStart);
          return {
            ...pl,
            top: at,
            height: Math.max(2, yAt(segEnd) - at),
            isHidden: clip.hidden,
            // A head arrived from the column before and a tail leaves for the
            // one after. Neither is clipped by the drawn hours as such, but
            // both are continuations and read identically to one that is.
            continuesAbove: clip.clippedAbove || isHead,
            continuesBelow: clip.clippedBelow || isTail,
            isTail,
            isHead,
          };
        });
    });
  }, [days, pxPerHour, yAt, dayStartH, shown]);

  /** What the columns actually draw. Anything with no drawn minutes is not
   *  among them: it is listed under the grid instead. */
  const placedByDate = useMemo(
    () => laidOutByDate.map(col => col.filter(pl => !pl.isHidden)),
    [laidOutByDate],
  );

  /**
   * Everything that falls in hours this device does not draw.
   *
   * IT USED TO BE SQUASHED AGAINST THE NEAREST EDGE, which is worse than
   * hiding it. A column running six in the morning to two the next, with dawn
   * prayer at 04:19, pinned Fajr to the foot of the column: it looked like a
   * prayer at a quarter to two, which is a time it is not, on a day it is not.
   * A wrong answer beats a missing one only when it is legible as a wrong
   * answer, and this one was not.
   *
   * So it is listed below the column instead, in order, with the times it
   * really has. Nothing is lost, nothing is tappable at the wrong hour, and the
   * gap in the timeline is drawn as a gap.
   */
  const outsideByDate = useMemo(() => days.map((d, i) => {
    const entries: OutsideEntry[] = [];

    for (const pl of laidOutByDate[i] ?? []) {
      if (!pl.isHidden) continue;
      const item = pl.item.item;
      // A night cut in two contributes at most one row: the piece that would
      // have been drawn on THIS column. Naming the event twice under one day
      // would read as two of them.
      entries.push({
        key: pl.item.id,
        at: pl.item.startMin,
        // The item's own clock times, not the segment's, so a night says when
        // it really begins and ends.
        label: item.title,
        detail: blockTiming({
          startMin: item.startMin ?? pl.item.startMin,
          endMin: item.endMin,
          timeFormat: clock,
          minutesLeft: null,
        }),
        colour: item.colour ?? p.accent,
        done: item.completed,
        onPress: () => onOpenItem(item),
      });
    }

    for (const pr of d.prayers) {
      const at = pr.minutes < dayStartH * 60 ? pr.minutes + 1440 : pr.minutes;
      if (isMinuteVisible(at, shown)) continue;
      const done = isPrayerDone ? isPrayerDone(d.date, pr.key) : false;
      entries.push({
        key: `prayer:${d.date}:${pr.key}`,
        at,
        label: pr.label,
        detail: { range: formatClock(pr.minutes, clock), detail: '', live: false },
        colour: prayerColour ?? p.accent,
        done,
        onPress: onTogglePrayer ? () => onTogglePrayer(d.date, pr.key) : undefined,
      });
    }

    // In time order, and stably: two things at the same minute must not swap
    // places between renders.
    entries.sort((a, b) => (a.at - b.at) || a.key.localeCompare(b.key));
    return entries;
  }), [days, laidOutByDate, shown, dayStartH, clock, p.accent, prayerColour,
       isPrayerDone, onTogglePrayer, onOpenItem]);

  const anyOutside = outsideByDate.some(list => list.length > 0);

  /**
   * Where the grid should be looking: the current hour, with a little of what
   * came before it for context.
   *
   * Computed during render rather than in an effect, because it is needed
   * BEFORE the first paint. Read through a ref so the clock ticking over does
   * not become a reason to move the grid (see the effect below).
   */
  const scrollTargetFor = useCallback((minute: number | null) => {
    if (minute === null) return 0;
    return Math.max(0, yAt(inWindow(minute)) - 120);
  }, [yAt, inWindow]);

  const nowMinRef = useRef(nowMin);
  nowMinRef.current = nowMin;

  /**
   * Whether the now-line has been scrolled off the screen.
   *
   * State, not a ref, because the button appearing IS the render. It is set
   * from the scroll handler, which runs sixteen times a second, so it is
   * written through a comparison: React bails out when the boolean has not
   * changed, and it only changes when the line crosses an edge.
   */
  const [liveOffscreen, setLiveOffscreen] = useState(false);
  const viewportH = useRef(0);

  /** Where the now-line sits in the scrolled content, or null on a day that is
   *  not today. */
  const liveY = useCallback((): number | null => {
    const minute = nowMinRef.current;
    if (minute === null) return null;
    return yAt(inWindow(minute));
  }, [yAt, inWindow]);

  const checkLive = useCallback((offset: number) => {
    const y = liveY();
    if (y === null || viewportH.current <= 0) {
      setLiveOffscreen(false);
      return;
    }
    // A margin either side, so the button does not flicker into existence for
    // a line that is technically visible but jammed against an edge.
    const off = y < offset + 48 || y > offset + viewportH.current - 48;
    setLiveOffscreen(prev => (prev === off ? prev : off));
  }, [liveY]);

  /**
   * Put the current time in the MIDDLE of the screen, the way the PC's own
   * button does. The initial placement (`scrollTargetFor`) deliberately leaves
   * the now-line low, with the last couple of hours above it for context; this
   * is a different question, asked by someone who has scrolled away and wants
   * to be taken back.
   */
  const goToLive = useCallback(() => {
    const y = liveY();
    if (y === null) return;
    scroller.current?.scrollTo({
      y: Math.max(0, y - viewportH.current / 2),
      animated: true,
    });
  }, [liveY]);

  /**
   * The position the grid is BORN at.
   *
   * THE FLASH THIS REMOVES. The grid used to mount at the top and then scroll
   * down to the current hour from an effect, one frame later. For a fraction of
   * a second you saw midnight -- for anyone with something drawn across the
   * small hours, a wall of sleep -- and then it jumped. Every return to the
   * calendar did it: from Tasks, from Focus, from Settings, and on launch.
   *
   * A ScrollView handed `contentOffset` starts there instead, so the first
   * frame drawn is already the right one and there is nothing to jump from.
   * The effect below stays as the correction for the cases an initial offset
   * cannot cover: the row heights changing under it, or a different day being
   * chosen while the view is already mounted.
   */
  const initialOffset = useMemo(
    () => ({ x: 0, y: scrollTargetFor(nowMinRef.current) }),
    // Deliberately empty: this is the value at MOUNT and must not be
    // recomputed, or React Native re-applies it and yanks the grid back to now
    // under the reader's thumb.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * Whether the grid has actually been placed yet.
   *
   * `contentOffset` is honoured once the content has a size. The grid's height
   * is deterministic, so that is the first layout -- but a phone that has not
   * applied it by then would sit at the top with nothing to correct it, which
   * is the exact flash this is all here to remove. So the first content-size
   * report checks, and places the grid itself if it has to.
   */
  const placedRef = useRef(false);

  /**
   * The pill also has to react to the CLOCK, not only to scrolling.
   *
   * `checkLive` was called from the scroll handler and nowhere else, so sitting
   * still while the now-line drifted off the bottom of the screen left no offer
   * to follow it -- until you happened to scroll, at which point the button
   * appeared as if from nowhere. The agenda view already recomputes on the
   * minute; this is the same thing said here.
   */
  useEffect(() => {
    checkLive(scrollY.current);
  }, [nowMin, checkLive]);

  /**
   * Put the grid back where it belongs when the SHAPE of it changes.
   *
   * Keyed on the geometry and the days on screen, never on the clock. It used
   * to depend on `nowMin`, so every time the minute ticked over the grid
   * scrolled itself back to the current hour -- whatever you had scrolled to
   * and whatever you were reading at the time.
   */
  const shapeKey = `${dates.join(',')}|${pxPerHour}|${dayStartH}|${gridHeight}`;
  const lastShapeRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastShapeRef.current === shapeKey) return;
    const first = lastShapeRef.current === null;
    lastShapeRef.current = shapeKey;
    // On the very first pass `contentOffset` has already put us there, so
    // scrolling again would only risk a visible correction.
    if (first) return;
    const target = scrollTargetFor(nowMinRef.current);
    const id = setTimeout(
      () => scroller.current?.scrollTo({ y: target, animated: false }),
      0,
    );
    return () => clearTimeout(id);
  }, [shapeKey, scrollTargetFor]);

  // ─── Gesture state ─────────────────────────────────────────────────────────
  // Three things the render needs, and a pile of bookkeeping it does not. The
  // bookkeeping lives in refs because the PanResponder is built once and would
  // otherwise close over the first render's values forever.

  const canCreate = !!onCreateRange;
  const canMove = !!onMoveItem;
  const dragEnabled = canCreate || canMove;

  /** The block the user picked up. It STAYS lifted after the finger goes, which
   *  is what gives the resize grip something to appear on. */
  const [lifted, setLifted] = useState<{ id: string; date: string } | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [gridW, setGridW] = useState(0);

  const gridRef = useRef<View>(null);
  const scrollY = useRef(0);
  /** Page y the top of the grid would have at scroll offset zero. Everything is
   *  measured from this, minus the current scroll, so it survives scrolling. */
  const pageTop = useRef(0);
  const pageLeft = useRef(0);

  const ghostIn = useRef(new Animated.Value(0)).current;

  /** Everything the responder needs from the current render. */
  const geom = useRef({
    dates, days, placedByDate, pxPerHour, shown, interval, gridW,
    lifted, canCreate, canMove,
  });
  geom.current = {
    dates, days, placedByDate, pxPerHour, shown, interval, gridW,
    lifted, canCreate, canMove,
  };

  const touch = useRef({
    x: 0, y: 0, active: false,
    /** Set when a hold has fired, so a move may claim the responder. */
    armed: null as null | { mode: 'create' | 'move' | 'resize'; anchorMin: number },
    /** A lifted block under the finger, draggable without a fresh hold. */
    ready: null as null | { mode: 'move' | 'resize'; item: AgendaItem; date: string },
    /** True from the moment a gesture is taken over, so the tap underneath it
     *  does not also fire when the finger comes up. */
    consumed: false,
  });
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const clearHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };

  /** Page coordinates to grid coordinates, with the current scroll taken out. */
  const toGrid = (pageX: number, pageY: number) => ({
    x: pageX - pageLeft.current,
    y: pageY - pageTop.current + scrollY.current,
  });

  /** Which column, and which block inside it, a point is over. */
  const hitTest = useCallback((x: number, y: number) => {
    const g = geom.current;
    const count = g.dates.length;
    const col = columnAtX(x, RAIL, g.gridW, count);
    const date = g.dates[col] ?? g.dates[0];
    const colW = count > 0 ? (g.gridW - RAIL) / count : 0;
    const inCol = x - RAIL - colW * col;

    let hit: { item: AgendaItem; placed: Placed<GridItem>; onGrip: boolean } | null = null;
    for (const pl of g.placedByDate[col] ?? []) {
      if (y < pl.top || y > pl.top + pl.height) continue;
      // Overlapping blocks share a column, so the horizontal half matters too;
      // without this the block underneath can never be picked up at all.
      const w = colW / pl.columns;
      const left = w * pl.column;
      if (inCol < left || inCol > left + w) continue;
      hit = { item: pl.item.item, placed: pl, onGrip: y > pl.top + pl.height - GRIP_ZONE };
    }
    return { col, date, hit, minutes: minuteAtY(y, g.shown, g.pxPerHour) };
  }, []);

  const stopDrag = useCallback(() => {
    draggingRef.current = false;
    setDragging(false);
    setDrag(null);
    touch.current.armed = null;
    touch.current.ready = null;
    ghostIn.setValue(0);
  }, [ghostIn]);

  /** The hold completed. Decide what the finger is on and start showing it. */
  const arm = useCallback(() => {
    const g = geom.current;
    const t = touch.current;
    if (!t.active) return;
    const { date, hit, minutes } = hitTest(t.x, t.y);

    if (hit && g.canMove) {
      t.armed = { mode: 'move', anchorMin: minutes };
      setLifted({ id: hit.item.id, date });
      setDrag({
        mode: 'move', date, item: hit.item,
        startMin: hit.item.startMin ?? 0, endMin: hit.item.endMin,
      });
    } else if (!hit && g.canCreate) {
      // The ghost appears at one slot long the instant the hold lands, so the
      // gesture confirms itself before the finger has moved anywhere.
      const r = createRange({
        anchorMin: minutes, currentMin: minutes,
        interval: g.interval,
        fromHour: g.shown[0].from, toHour: g.shown[g.shown.length - 1].to,
      });
      t.armed = { mode: 'create', anchorMin: minutes };
      setDrag({ mode: 'create', date, startMin: r.startMin, endMin: r.endMin });
    } else {
      return;
    }

    t.consumed = true;
    draggingRef.current = true;
    setDragging(true);
    Animated.timing(ghostIn, { toValue: 1, duration: 120, useNativeDriver: true }).start();
  }, [ghostIn, hitTest]);

  const beginTouch = useCallback((pageX: number, pageY: number) => {
    // Re-measure on every touch. It costs nothing next to a gesture and it is
    // the only thing that keeps the origin honest across rotation, a keyboard
    // opening, or the all-day band appearing.
    gridRef.current?.measureInWindow((mx, my) => {
      pageLeft.current = mx;
      pageTop.current = my + scrollY.current;
    });

    const pt = toGrid(pageX, pageY);
    const t = touch.current;
    t.x = pt.x; t.y = pt.y; t.active = true; t.armed = null; t.consumed = false;

    const g = geom.current;
    const { date, hit } = hitTest(pt.x, pt.y);
    // An already lifted block is armed and waiting: it needs no second hold,
    // which is what makes nudging it and grabbing its grip feel immediate.
    t.ready = hit && g.canMove && g.lifted?.id === hit.item.id
      ? { mode: hit.onGrip ? 'resize' : 'move', item: hit.item, date }
      : null;

    clearHold();
    holdTimer.current = setTimeout(arm, HOLD_MS);
  }, [arm, hitTest]);

  /** Follow the finger. Called on every frame of a live drag. */
  const follow = useCallback((pageX: number, pageY: number, dx: number, dy: number) => {
    const g = geom.current;
    const t = touch.current;
    const cur = dragRef.current;
    if (!t.armed || !cur) return;
    const pt = toGrid(pageX, pageY);
    const minutes = minuteAtY(pt.y, g.shown, g.pxPerHour);
    const win = {
      interval: g.interval,
      fromHour: g.shown[0].from, toHour: g.shown[g.shown.length - 1].to,
    };

    let next: Drag;
    if (cur.mode === 'create') {
      // A create stays in the column it started in. Sweeping sideways while
      // drawing a range would ask what a range across two days even means.
      const r = createRange({ anchorMin: t.armed.anchorMin, currentMin: minutes, ...win });
      next = { ...cur, startMin: r.startMin, endMin: r.endMin };
    } else if (cur.mode === 'resize') {
      const r = resizeBlock({
        startMin: cur.startMin, endMin: cur.endMin, pointerMin: minutes, ...win,
      });
      next = { ...cur, endMin: r.endMin };
    } else {
      const base = cur.item;
      const b = moveBlock({
        startMin: base.startMin ?? 0, endMin: base.endMin,
        deltaMin: (dy * 60) / g.pxPerHour, ...win,
      });
      const col = columnAtX(pt.x, RAIL, g.gridW, g.dates.length);
      next = { ...cur, date: g.dates[col] ?? cur.date, startMin: b.startMin, endMin: b.endMin };
    }

    // Only re-render when the SNAPPED result actually changed. Sixty state
    // updates a second for a block that has not moved a slot is the difference
    // between this feeling instant and feeling like tar.
    if (next.date !== cur.date || next.startMin !== cur.startMin || next.endMin !== cur.endMin) {
      setDrag(next);
    }
  }, []);

  const finish = useCallback((commit: boolean) => {
    clearHold();
    const t = touch.current;
    // Both the responder release and the raw touch end can arrive for the same
    // finger, and `dragRef` still holds the old drag until the next render, so
    // without this guard a single drop would be committed twice.
    if (!t.active && !draggingRef.current) return;
    const cur = dragRef.current;
    t.active = false;

    if (commit && cur) {
      // The grid counts in its own frame, where a window that opens at 6am runs
      // to 30:00. A time is written back to the store as a CLOCK time on a
      // date, so anything past the end of the day rolls over to the next one.
      const rolled = cur.startMin >= 1440;
      const date = rolled ? addDays(cur.date, 1) : cur.date;
      const startMin = rolled ? cur.startMin - 1440 : cur.startMin;
      const endMin = cur.endMin === null
        ? null
        : ((rolled ? cur.endMin - 1440 : cur.endMin) + 1440) % 1440;

      if (cur.mode === 'create') {
        onCreateRange?.({ date, startMin, endMin: endMin ?? startMin + 30 });
        setLifted(null);
      } else {
        onMoveItem?.({ item: cur.item, date, startMin, endMin });
        // The block stays lifted so it can be nudged again or resized without
        // holding it a second time.
        setLifted({ id: cur.item.id, date });
      }
    }
    stopDrag();
  }, [onCreateRange, onMoveItem, stopDrag]);

  const pan = useRef(PanResponder.create({
    // Never claimed on touch down. This handler exists only to notice the touch
    // and start the hold timer; returning true here would eat every tap.
    onStartShouldSetPanResponderCapture: evt => {
      if (!geom.current.canCreate && !geom.current.canMove) return false;
      beginTouch(evt.nativeEvent.pageX, evt.nativeEvent.pageY);
      return false;
    },
    // The one place the gesture is taken over, and it is a CAPTURE handler
    // because by now the block's own Pressable is the responder and only a
    // capture can take it from a child.
    onMoveShouldSetPanResponderCapture: (evt, g) => {
      const t = touch.current;
      if (!t.active) return false;
      if (t.armed) return true;

      const far = Math.abs(g.dx) > HOLD_SLOP || Math.abs(g.dy) > HOLD_SLOP;
      if (t.ready && (Math.abs(g.dx) > LIFTED_SLOP || Math.abs(g.dy) > LIFTED_SLOP)) {
        const { mode, item, date } = t.ready;
        clearHold();
        t.armed = { mode, anchorMin: item.startMin ?? 0 };
        t.consumed = true;
        draggingRef.current = true;
        setDragging(true);
        setDrag({ mode, date, item, startMin: item.startMin ?? 0, endMin: item.endMin });
        ghostIn.setValue(1);
        return true;
      }
      // Moved before the hold completed: this is a scroll, so let it go and do
      // not try again until the finger is lifted.
      if (far) { clearHold(); t.active = false; }
      return false;
    },
    onPanResponderMove: (evt, g) => {
      follow(evt.nativeEvent.pageX, evt.nativeEvent.pageY, g.dx, g.dy);
    },
    // Once this is a drag it is not handed back. A ScrollView asking mid-gesture
    // is exactly the case that would drop the block halfway.
    onPanResponderTerminationRequest: () => !draggingRef.current,
    onPanResponderRelease: () => finish(true),
    onPanResponderTerminate: () => finish(false),
    onShouldBlockNativeResponder: () => true,
  })).current;

  // A touch that ends without the responder ever changing hands still has to
  // clean up: a hold that armed and then lifted with no movement leaves a ghost
  // on screen otherwise.
  const endStrayTouch = useCallback(() => {
    clearHold();
    if (!draggingRef.current) { touch.current.active = false; return; }
    finish(true);
  }, [finish]);

  /** Taps, with the drag taken into account. */
  const openItem = useCallback((item: AgendaItem) => {
    if (touch.current.consumed) { touch.current.consumed = false; return; }
    setLifted(null);
    onOpenItem(item);
  }, [onOpenItem]);

  const openDay = useCallback((date: string) => {
    if (touch.current.consumed) { touch.current.consumed = false; return; }
    // A tap on empty grid while something is lifted puts it down rather than
    // navigating, so there is always an obvious way to cancel.
    if (lifted) { setLifted(null); return; }
    onOpenDay(date);
  }, [lifted, onOpenDay]);

  const columnCount = days.length;
  const colW = gridW > 0 && columnCount > 0 ? (gridW - RAIL) / columnCount : 0;

  /**
   * How much of a prayer marker fits, from the MEASURED column width.
   *
   * The marker drops its time, then its name, as the column narrows. Deriving
   * that from the number of days instead would be wrong on a landscape phone or
   * a tablet, where seven columns are wide enough for the whole pill. The width
   * is already measured here for the drag layer, so this costs nothing.
   */
  const chipMode: PrayerChipMode = prayerChipMode(colW);
  const dragCol = drag ? Math.max(0, dates.indexOf(drag.date)) : -1;

  return (
    <View style={{ flex: 1 }}>
      {/* Day headings */}
      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: p.line }}>
        <View style={{ width: RAIL }} />
        {days.map(d => {
          const date = new Date(`${d.date}T00:00:00`);
          const isToday = d.date === today;
          const isTarget = drag !== null && drag.date === d.date;
          return (
            <Pressable
        unstable_pressDelay={TAP_DELAY}
              key={d.date}
              onPress={() => onOpenDay(d.date)}
              style={{
                flex: 1,
                alignItems: 'center',
                paddingVertical: space.sm,
                // While a block is being carried, its destination day is called
                // out up here as well, because in a seven column week the ghost
                // itself is too narrow to be sure about.
                backgroundColor: isTarget ? p.accentSoft : 'transparent',
              }}
            >
              <Text variant="caption" tone={isToday || isTarget ? 'accent' : 'faint'} style={{ fontSize: 10 }}>
                {date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
              </Text>
              <Text
                variant="bodyStrong"
                tone={isToday || isTarget ? 'accent' : 'ink'}
                style={{ fontSize: 15 }}
              >
                {date.getDate()}
              </Text>
            </Pressable>
          );
        })}
      </View>

      {/* ── Prayers in a row of their own ──
          Out of the grid entirely, which is the point of this style: a day with
          six prayers drawn through it is six lines across everything else, and
          on a phone that is most of the screen. Here they sit in one band above
          the grid, in time order, and the grid below is left to the things that
          actually occupy time. */}
      {prayerStyle === 'row' && days.some(d => d.prayers.length > 0) ? (
        <View style={{
          flexDirection: 'row',
          borderBottomWidth: 1,
          borderBottomColor: p.line,
          backgroundColor: p.surface,
          paddingVertical: 4,
        }}>
          <View style={{
            width: RAIL, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 4,
          }}>
            <Text variant="caption" tone="faint" style={{ fontSize: 9 }}>pray</Text>
          </View>
          {days.map(d => (
            <View key={d.date} style={{ flex: 1, paddingHorizontal: 1, gap: 2 }}>
              {d.prayers.map(pr => {
                const colour = prayerColour ?? p.ok;
                const done = isPrayerDone?.(d.date, pr.key) ?? false;
                return (
                  <Pressable
        unstable_pressDelay={TAP_DELAY}
                    key={pr.key}
                    onPress={() => onTogglePrayer?.(d.date, pr.key)}
                    accessibilityRole="button"
                    accessibilityLabel={`${pr.label}, ${formatClock(pr.minutes, clock)}${done ? ', prayed' : ''}`}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 3,
                      borderRadius: 3,
                      borderWidth: 1,
                      borderColor: colour,
                      backgroundColor: `${colour}1f`,
                      paddingHorizontal: 3,
                      paddingVertical: 1,
                      opacity: done ? 0.5 : 1,
                    }}
                  >
                    <Text style={{ color: colour, fontSize: 8, lineHeight: 10 }}>
                      {done ? '◉' : '○'}
                    </Text>
                    <Text
                      numberOfLines={1}
                      style={{
                        color: colour, fontSize: 9, lineHeight: 12, flexShrink: 1,
                        textDecorationLine: done ? 'line-through' : 'none',
                      }}
                    >
                      {/* The width decides how much is worth saying, exactly as
                          it does for the in-grid marker. */}
                      {chipMode === 'dot' ? formatClock(pr.minutes, clock) : pr.label}
                    </Text>
                    {chipMode === 'full' ? (
                      <Text style={{
                        color: colour, fontSize: 8.5, lineHeight: 12, opacity: 0.8,
                        marginLeft: 'auto',
                      }}>
                        {formatClock(pr.minutes, clock)}
                      </Text>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </View>
      ) : null}

      {/* All-day band, only when there is one */}
      {anyAllDay ? (
        <View style={{
          flexDirection: 'row',
          borderBottomWidth: 1,
          borderBottomColor: p.line,
          backgroundColor: p.surface,
          paddingVertical: 4,
        }}>
          <View style={{ width: RAIL, justifyContent: 'center', alignItems: 'flex-end', paddingRight: 4 }}>
            <Text variant="caption" tone="faint" style={{ fontSize: 9 }}>all</Text>
          </View>
          {days.map(d => (
            <View key={d.date} style={{ flex: 1, paddingHorizontal: 1, gap: 2 }}>
              {d.allDay.slice(0, 2).map(item => (
                <Pressable
        unstable_pressDelay={TAP_DELAY}
                  key={item.id}
                  onPress={() => onOpenItem(item)}
                  style={{
                    backgroundColor: item.colour ?? p.accent,
                    borderRadius: 3,
                    paddingHorizontal: 3,
                    paddingVertical: 2,
                    opacity: item.completed ? 0.5 : 1,
                  }}
                >
                  <Text numberOfLines={1} style={{ color: '#fff', fontSize: 9, lineHeight: 12 }}>
                    {item.title}
                  </Text>
                </Pressable>
              ))}
              {d.allDay.length > 2 ? (
                <Text variant="caption" tone="faint" style={{ fontSize: 9, paddingLeft: 3 }}>
                  +{d.allDay.length - 2}
                </Text>
              ) : null}
            </View>
          ))}
        </View>
      ) : null}

      <ScrollView
        ref={scroller}
        scrollEnabled={!dragging}
        // 16ms is ~60 callbacks a second into JS, all to decide whether one
        // button should be visible. The button arriving a frame or two later is
        // not noticeable; the frames handed back while scrolling are.
        scrollEventThrottle={64}
        // The first frame is drawn here, not at the top and then moved.
        contentOffset={initialOffset}
        onContentSizeChange={() => {
          if (placedRef.current) return;
          placedRef.current = true;
          if (initialOffset.y <= 0) return;
          // Only if the offset was not taken. Scrolling to where we already
          // are would be a no-op on most phones and a visible correction on
          // the rest, so it is asked as a question rather than done blindly.
          if (Math.abs(scrollY.current - initialOffset.y) < 2) return;
          scroller.current?.scrollTo({ y: initialOffset.y, animated: false });
        }}
        onScroll={e => {
          scrollY.current = e.nativeEvent.contentOffset.y;
          viewportH.current = e.nativeEvent.layoutMeasurement.height;
          checkLive(scrollY.current);
        }}
        onLayout={e => {
          viewportH.current = e.nativeEvent.layout.height;
          checkLive(scrollY.current);
        }}
        // A little air at the top, so the first hour is not flush against
        // whatever sits above the grid.
        contentContainerStyle={{ paddingTop: space.sm, paddingBottom: space.xxl }}
      >
        <View
          ref={gridRef}
          onLayout={() => {
            gridRef.current?.measureInWindow((mx, my, w) => {
              pageLeft.current = mx;
              pageTop.current = my + scrollY.current;
              if (w > 0) setGridW(w);
            });
          }}
          onTouchEnd={dragEnabled ? endStrayTouch : undefined}
          onTouchCancel={dragEnabled ? endStrayTouch : undefined}
          style={{ flexDirection: 'row', height: gridHeight }}
          {...(dragEnabled ? pan.panHandlers : {})}
        >
          {/* The rail labels EVERY slot, not just the hour. Showing only hours
              while the grid is ruled every five minutes leaves the lines
              unreadable: you can see that something is subdivided but not into
              what. The hour keeps the stronger weight so the eye can still find
              it at a glance. */}
          <View style={{ width: RAIL }}>
            {slots.map(m => {
              const onHour = m % 60 === 0;
              return (
                <Text
                  key={m}
                  variant="caption"
                  tone={onHour ? 'soft' : 'faint'}
                  style={{
                    position: 'absolute',
                    // Never above the grid. A label centred on the very first
                    // line sits at a negative offset, where Android clips it,
                    // which is why midnight looked tangled with the row above.
                    top: Math.max(0, yAt(m) - (onHour ? 7 : 6)),
                    right: 4,
                    fontSize: onHour ? 10 : 8.5,
                    fontWeight: onHour ? '700' : '400',
                    opacity: onHour ? 1 : 0.8,
                  }}
                >
                  {formatClock(m, clock)}
                </Text>
              );
            })}

            {/* The two times being dragged, pinned to the rail. The ghost shows
                them too, but a column in a seven day week is too narrow to read
                and the rail always has room. */}
            {drag ? [
              { m: drag.startMin, key: 'a' },
              { m: drag.endMin ?? drag.startMin, key: 'b' },
            ].map(({ m, key }) => (
              <View
                key={key}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: yAt(m) - 8,
                  right: 2,
                  backgroundColor: p.accent,
                  borderRadius: radius.sm,
                  paddingHorizontal: 4,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ color: p.accentInk, fontSize: 9, lineHeight: 12, fontWeight: '700' }}>
                  {formatClock(m, clock)}
                </Text>
              </View>
            )) : null}

            {/* The time it is now, on the rail, in the same red as the line
                across the grid. The rail is a column of times, so the current
                one belongs in it — and reading the clock off the thing you are
                already looking at beats hunting for where the line crosses. */}
            {nowMin !== null ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: yAt(inWindow(nowMin)) - 8,
                  right: 2,
                  backgroundColor: p.danger,
                  borderRadius: radius.sm,
                  paddingHorizontal: 4,
                  paddingVertical: 1,
                }}
              >
                <Text style={{ color: '#fff', fontSize: 9, lineHeight: 12, fontWeight: '800' }}>
                  {formatClock(nowMin, clock)}
                </Text>
              </View>
            ) : null}

            {/* The same break the columns draw. Without it the rail reads as
                a continuous list of times, and 1:55am sitting directly above
                8:00am looks like a rendering fault rather than four hours
                deliberately left out. */}
            {seams.map(at => (
              <View
                key={`railseam${at}`}
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  top: at * (pxPerHour / 60) - 2,
                  left: 0, right: 0, height: 4,
                  backgroundColor: p.bg,
                  borderTopWidth: 1, borderBottomWidth: 1,
                  borderTopColor: p.line, borderBottomColor: p.line,
                }}
              />
            ))}
          </View>

          {/* Columns */}
          {days.map((d, i) => (
            <DayColumn
              shown={shown}
              dayWindow={dayWindow}
              key={d.date}
              placed={placedByDate[i]}
              yAt={yAt}
              seams={seams}
              height={gridHeight}
              pxPerHour={pxPerHour}
              marks={marks}
              slots={slots}
              detailed={detailed}
              columnWidth={colW}
              clock={clock}
              prayers={prayerStyle === 'row' ? [] : d.prayers}
              prayerColour={prayerColour}
              prayerLabels={prayerLabels}
              chipMode={chipMode}
              prayerStyle={prayerStyle}
              isPrayerDone={isPrayerDone ? (key: string) => isPrayerDone(d.date, key) : undefined}
              onTogglePrayer={onTogglePrayer ? (key: string) => onTogglePrayer(d.date, key) : undefined}
              isToday={d.date === today}
              nowMin={d.date === today && nowMin !== null ? inWindow(nowMin) : null}
              liftedId={lifted?.date === d.date ? lifted.id : null}
              onMenuItem={onMenuItem}
              draggingId={drag && drag.mode !== 'create' ? drag.item.id : null}
              isDragTarget={drag !== null && drag.date === d.date}
              onOpenItem={openItem}
              onOpenDay={() => openDay(d.date)}
            />
          ))}

          {/* The ghost. One layer over the whole grid rather than something
              inside a column, because a move can end in a different column from
              the one it started in and a child cannot be drawn outside its
              parent. */}
          {drag && colW > 0 ? (
            <Ghost
              drag={drag}
              clock={clock}
              left={RAIL + colW * dragCol}
              width={colW}
              top={yAt(drag.startMin)}
              height={Math.max(
                14,
                yAt(drag.endMin ?? drag.startMin) - yAt(drag.startMin),
              )}
              fade={ghostIn}
            />
          ) : null}
        </View>

        {/* AFTER the last row, not inside it. Everything above this line is on
            the timeline and everything below it explicitly is not, which is the
            whole point: a prayer at 4am on a grid that stops at 2am was being
            pinned to the foot of the column, where it read as a prayer at a
            quarter to two. It kept the same rail and the same columns so each
            list still sits under the day it belongs to. */}
        {anyOutside ? (
          <View style={{ flexDirection: 'row' }}>
            <View style={{ width: RAIL }} />
            {days.map((d, i) => (
              <OutsideHours
                key={`outside-${d.date}`}
                entries={outsideByDate[i] ?? []}
                detailed={detailed}
              />
            ))}
          </View>
        ) : null}
      </ScrollView>

      {/*
        Go to live.

        Only ever visible when it has something to do: the moment the red line
        is back on screen it goes away again, so it is never a button sitting
        there asking to be ignored. Centred rather than in a corner because it
        is not an action on anything, it is a way back — and the corner already
        belongs to the add button.
      */}
      {liveOffscreen ? (
        <View
          pointerEvents="box-none"
          style={{ position: 'absolute', left: 0, right: 0, bottom: space.xl, alignItems: 'center' }}
        >
          <Pressable
        unstable_pressDelay={TAP_DELAY}
            onPress={goToLive}
            accessibilityRole="button"
            accessibilityLabel="Scroll back to the current time"
            android_ripple={{ color: p.surfaceAlt }}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 7,
              paddingLeft: 12,
              paddingRight: 16,
              paddingVertical: 9,
              borderRadius: radius.pill,
              backgroundColor: p.surface,
              borderWidth: 1,
              borderColor: p.line,
              transform: [{ scale: pressed ? 0.96 : 1 }],
              elevation: 8,
              shadowColor: '#000',
              shadowOpacity: 0.35,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 5 },
            })}
          >
            <View style={{
              width: 8, height: 8, borderRadius: 4, backgroundColor: p.danger,
            }} />
            <Text variant="bodyStrong" style={{ color: p.ink }}>Go to live</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/**
 * The block being drawn or carried.
 *
 * It is deliberately not a copy of the real block: it is an outline with the
 * times in it, so that at every moment it is obvious this is a preview of where
 * something will land rather than the thing itself.
 */
function Ghost({
  drag, clock, left, width, top, height, fade,
}: {
  drag: Drag;
  clock?: string;
  left: number;
  width: number;
  top: number;
  height: number;
  fade: Animated.Value;
}) {
  const p = useTheme();
  const colour = drag.mode === 'create'
    ? p.accent
    : (drag.item.colour ?? p.accent);

  const range = drag.endMin !== null
    ? `${formatClock(drag.startMin, clock)} to ${formatClock(drag.endMin, clock)}`
    : formatClock(drag.startMin, clock);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        left, width, top, height,
        paddingHorizontal: 1,
        opacity: fade.interpolate({ inputRange: [0, 1], outputRange: [0.35, 1] }),
        transform: [{ scale: fade.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }],
      }}
    >
      <View style={{
        flex: 1,
        backgroundColor: colour,
        opacity: 0.62,
        borderRadius: radius.sm,
        borderWidth: 1.5,
        borderColor: '#fff',
        paddingHorizontal: 3,
        paddingTop: 1,
        overflow: 'hidden',
        justifyContent: height > 34 ? 'flex-start' : 'center',
      }}>
        <Text
          numberOfLines={1}
          style={{ color: '#fff', fontSize: 9, lineHeight: 11, fontWeight: '700' }}
        >
          {range}
        </Text>
        {height > 34 ? (
          <Text numberOfLines={1} style={{ color: '#fff', fontSize: 9, lineHeight: 12, opacity: 0.9 }}>
            {drag.mode === 'create' ? 'New event' : drag.item.title}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

function DayColumn({
  shown = FULL_DAY, dayWindow, placed, yAt, height, pxPerHour, marks, slots, detailed, clock, prayers, seams,
  prayerColour, prayerLabels, chipMode, prayerStyle, isPrayerDone, onTogglePrayer, isToday, nowMin, liftedId, draggingId, isDragTarget, onMenuItem, onOpenItem, onOpenDay, columnWidth,
}: {
  /** The drawn stretches, already normalised by the grid above. */
  shown?: readonly HourRange[];
  dayWindow?: { start: number; end: number };
  placed: Placed<GridItem>[];
  yAt: (minute: number) => number;
  height: number;
  pxPerHour: number;
  marks: number[];
  slots: number[];
  detailed?: boolean;
  /** Drawn width of one column, which decides whether a word fits on a block. */
  columnWidth?: number;
  clock?: string;
  prayers: { key: string; label: string; minutes: number }[];
  seams: number[];
  prayerColour?: string;
  prayerLabels?: boolean;
  chipMode: PrayerChipMode;
  prayerStyle: PrayerDrawStyle;
  isPrayerDone?: (key: string) => boolean;
  onTogglePrayer?: (key: string) => void;
  isToday: boolean;
  nowMin: number | null;
  /** The block the user has picked up, if it is in this column. */
  liftedId: string | null;
  onMenuItem?: (item: AgendaItem) => void;
  /** The block currently under the thumb, drawn faint since the ghost has it. */
  draggingId: string | null;
  /** True while a drag is aiming at this day. */
  isDragTarget: boolean;
  onOpenItem: (item: AgendaItem) => void;
  onOpenDay: () => void;
}) {
  const p = useTheme();

  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={onOpenDay}
      style={{
        flex: 1,
        height,
        borderLeftWidth: 1,
        borderLeftColor: p.line,
        backgroundColor: isDragTarget ? p.accentSoft : isToday ? p.accentSoft : 'transparent',
      }}
    >
      {/* Slot lines first, then the hours over them: the hour has to stay
          readable as the stronger line however fine the slots are.

          While a drag is aiming here the slot lines come up in the accent
          colour, which is the only honest way to show where the block can
          actually land: these lines ARE the snap positions. */}
      {slots.map(m => (
        <View
          key={`s${m}`}
          style={{
            position: 'absolute',
            top: yAt(m),
            left: 0, right: 0,
            height: 1,
            backgroundColor: isDragTarget ? p.accent : p.line,
            opacity: isDragTarget ? 0.35 : 0.22,
          }}
        />
      ))}
      {marks.map(h => (
        <View
          key={h}
          style={{
            position: 'absolute',
            top: yAt(h * 60),
            left: 0, right: 0,
            height: 1,
            backgroundColor: p.line,
            opacity: 0.7,
          }}
        />
      ))}

      {placed.map(pl => {
        const item = pl.item.item;
        const width = `${100 / pl.columns}%`;
        const isLifted = item.id === liftedId;
        const isBeingDragged = item.id === draggingId;
        // The fill, and the one ink that can be read on it. Worked out once
        // here so the title, the second line, both outlines and the resize grip
        // cannot disagree with each other about which they are drawn on.
        const fill = item.colour ?? p.accent;
        const ink = inkOn(fill);

        // WHAT THIS BLOCK SAYS ABOUT ITS OWN TIME.
        //
        // The times shown are the ITEM's, not the segment's: a night cut in
        // two at the foot of one column and the head of the next is one
        // meeting, and both halves should name the hour it really ends. Only
        // the liveness arithmetic works in segment coordinates, because that is
        // the space `nowMin` arrived in.
        const segStart = pl.item.startMin;
        // Everything in this lane is a timed item, so a null start is a record
        // that should never have reached the grid. It is checked rather than
        // asserted because a single bad row must not blank the whole day.
        const startMin = item.startMin;
        // A tail was clipped at the window's edge and carries on into the next
        // column, so its real end is further along than the piece is drawn.
        // Counting down to the clip would say a meeting ends at midnight when
        // it ends at two.
        const runEnd = pl.item.isTail === true && startMin !== null
          ? segStart + blockDurationMinutes(startMin, item.endMin)
          : blockEnd(pl.item);
        const minutesLeft = isBeingDragged
          ? null
          : minutesLeftAt(segStart, runEnd, nowMin);
        const timing = startMin === null
          ? { range: '', detail: '', live: false }
          : blockTiming({
            startMin,
            endMin: item.endMin,
            timeFormat: clock,
            minutesLeft,
          });
        const placement = blockLabelPlacement(pl.height);
        const showTimes = placement !== 'none' && timing.range.length > 0;

        // WHAT YOU ARE LOOKING AT IS NOT ALL OF IT.
        //
        // Two ways that happens and they are the same fact from either end: the
        // block runs past the last hour this device draws, or it ran past the
        // foot of yesterday's column and this is the remainder. Both used to be
        // silent, so a night from half past midnight to nine on a grid that
        // stops at two was simply an hour and a half of sleep.
        const continuesAbove = (pl as { continuesAbove?: boolean }).continuesAbove === true;
        const continuesBelow = (pl as { continuesBelow?: boolean }).continuesBelow === true;
        // Under about twenty points there is no room for a marker that would
        // not cover the block it is describing.
        const canMark = pl.height >= 22;
        // The word only when it fits. A seven column week gives each block
        // about forty points, where "continued" would ellipsise into
        // "contin..." and say less than the arrow on its own does.
        const markWord = (columnWidth ?? 0) >= 96;
        const mark = (dir: 'up' | 'down') => (
          <View
            key={`continued-${dir}`}
            style={{ flexDirection: 'row', justifyContent: 'center', alignItems: 'center' }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: ink,
                opacity: inkOpacityOn(fill),
                fontSize: markWord ? 8.5 : 7.5,
                lineHeight: markWord ? 10 : 9,
                fontWeight: '700',
                letterSpacing: 0.2,
              }}
            >
              {dir === 'up'
                ? `\u25b2${markWord ? ' continued' : ''}`
                : `${markWord ? 'continued ' : ''}\u25bc`}
            </Text>
          </View>
        );

        /**
         * The time line. Drawn at the foot of anything with room for it, and at
         * the head as well once the block is tall enough that its two edges are
         * far apart -- which is when you are looking at one end and comparing
         * it against whatever is next to THAT end.
         *
         * The range is muted and the detail is not. While the block is running,
         * the detail is the countdown, and the countdown is the only thing on
         * the face of it that is urgent. Emphasis rather than a fixed red does
         * that job on all ten category colours: a red that reads on the green
         * block in the screenshot disappears on a red one.
         */
        const timeFont = detailed ? 10 : 8;
        const timeLeading = detailed ? 13 : 10;
        const timeLine = (key: string) => (
          // TWO SEPARATE TEXTS, not one with a span inside it. A nested `Text`
          // here is the app's own, which applies a whole type style rather than
          // just the bits named, so it reset to 15pt body copy and swamped the
          // block. And `opacity` on a nested span is not honoured on Android
          // anyway, so the muting had to be a real element to apply to.
          <View
            key={key}
            style={{
              flexDirection: detailed ? 'row' : 'column',
              alignItems: detailed ? 'center' : 'flex-start',
            }}
          >
            <Text
              numberOfLines={detailed ? 1 : 2}
              style={{
                color: ink,
                opacity: inkOpacityOn(fill),
                fontSize: timeFont,
                lineHeight: timeLeading,
                fontWeight: '500',
                flexShrink: 1,
              }}
            >
              {timing.range}
            </Text>
            {timing.detail ? (
              <Text
                numberOfLines={1}
                style={{
                  color: ink,
                  fontSize: timeFont,
                  lineHeight: timeLeading,
                  // Full strength beside the muted range, and heavier still
                  // while it is counting down: on a block filled with the
                  // category's own colour, emphasis is the only highlight that
                  // works on all ten of them.
                  fontWeight: timing.live ? '800' : '500',
                  marginLeft: detailed ? 4 : 0,
                }}
              >
                {timing.detail}
              </Text>
            ) : null}
          </View>
        );

        return (
          <Pressable
        unstable_pressDelay={PRESS_DELAY}
            // The PIECE's id, not the item's: a night split into a tail and a
            // head is two blocks, and keying both by the event they came from
            // would collide.
            key={pl.item.id}
            onPress={() => {
              // A lifted block is already the subject of the gesture, so a tap
              // on it is asking what else it can do, not asking to open it.
              if (isLifted && onMenuItem) onMenuItem(item);
              else onOpenItem(item);
            }}
            style={{
              position: 'absolute',
              top: pl.top,
              height: pl.height,
              left: `${(100 / pl.columns) * pl.column}%`,
              width: width as any,
              paddingHorizontal: 1,
              // A lifted block is drawn above its neighbours, or the outline
              // that says it is lifted gets clipped by whatever overlaps it.
              zIndex: isLifted ? 2 : 1,
            }}
          >
            <View style={{
              flex: 1,
              backgroundColor: fill,
              borderRadius: 3,
              paddingHorizontal: detailed ? 6 : 3,
              paddingTop: 1,
              // Three states, in order of how loud they should be: carried
              // (faint, the ghost is doing the talking), lifted (raised and
              // outlined), normal.
              opacity: isBeingDragged ? 0.2 : item.completed ? 0.45 : 0.92,
              overflow: 'hidden',
              ...(isLifted && !isBeingDragged ? {
                borderWidth: 1.5,
                borderColor: ink,
                shadowColor: p.shadow,
                shadowOpacity: 0.45,
                shadowRadius: 6,
                shadowOffset: { width: 0, height: 3 },
                elevation: 6,
                opacity: 1,
              } : null),
            }}>
              {/* INK CHOSEN FROM THE FILL, not fixed at white.
                  The ten category swatches run from `#eab308` to `#6366f1`, and
                  white on the brightest four sits at roughly 2:1, which is
                  below every legibility floor there is. The month view already
                  worked this out and kept the answer to itself, so the same
                  event was readable there and not here. */}
              {canMark && continuesAbove ? mark('up') : null}
              {showTimes && placement === 'both' ? timeLine('top') : null}
              {/* `flex: 1` on the TITLE is what decides who loses when a block
                  is too short for everything in it. The title takes whatever
                  room is left over, so it is the thing that shrinks, and the
                  time lines are always drawn. That is the right way round: the
                  title is also on the row you tapped from and in the editor,
                  whereas the times are only here. It also pins the bottom label
                  to the bottom EDGE, which is the end time it is naming, rather
                  than leaving it floating under the title. */}
              <Text
                numberOfLines={detailed || placement === 'both' ? 2 : 1}
                style={{
                  flex: 1,
                  color: ink,
                  fontSize: detailed ? 12 : 9,
                  lineHeight: detailed ? 15 : 11,
                  fontWeight: detailed ? '600' : '400',
                }}
              >
                {item.title}
              </Text>
              {showTimes ? timeLine('bottom') : null}
              {canMark && continuesBelow ? mark('down') : null}
            </View>

            {/* The grip. It only exists once the block has been picked up, so
                it never competes with a tap, and it is drawn rather than
                touched: the grid's own responder decides what a drag near the
                bottom edge means, because a child view could not hand the
                gesture on if the finger left this block. */}
            {isLifted && !isBeingDragged ? (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0, right: 0, bottom: 1,
                  alignItems: 'center',
                }}
              >
                <View style={{
                  width: Math.max(16, Math.min(28, pl.height)),
                  height: 4,
                  borderRadius: 2,
                  // The grip is drawn on the block, so it takes the block's ink
                  // for the same reason the title does: a white grip on a pale
                  // fill is invisible, and an invisible grip reads as a missing
                  // feature rather than a light one.
                  backgroundColor: ink,
                  opacity: 0.95,
                }} />
              </View>
            ) : null}
          </Pressable>
        );
      })}

      {/* Where hours have been cut out. Without a break, 1am sits directly above
          6am with nothing to say four hours are missing, and the day quietly
          misreads as continuous. */}
      {seams.map(at => {
        const y = at * (pxPerHour / 60);
        return (
          <View
            key={`seam${at}`}
            pointerEvents="none"
            style={{
              position: 'absolute', top: y - 2, left: 0, right: 0, height: 4,
              backgroundColor: p.bg,
              borderTopWidth: 1, borderBottomWidth: 1,
              borderTopColor: p.line, borderBottomColor: p.line,
              opacity: 0.9,
            }}
          />
        );
      })}

      {/* Prayers, in whichever shape this device asked for.
          MARKER is a hairline with a pill sitting in it, which is what the desk
          draws. PILL is a short bar at the minute, which reads as "a thing at a
          time" rather than "a line through the day". Either way the tap target
          is the shape itself and never the line, so nothing here can swallow a
          drag meant for the grid. */}
      {prayers.map(pr => {
        const colour = prayerColour ?? p.ok;
        const done = isPrayerDone?.(pr.key) ?? false;
        // A prayer before the window opens belongs to the far end of the same
        // window, not to the top of it.
        const normM = pr.minutes < (dayWindow?.start ?? 0) * 60 ? pr.minutes + 1440 : pr.minutes;
        // Not drawn here at all any more. It is listed under the column with
        // its real time instead of being pinned to whichever edge it fell off,
        // which is the one place it could sit without claiming an hour it does
        // not have.
        if (!isMinuteVisible(normM, shown)) return null;
        const top = yAt(normM);
        const named = chipMode !== 'dot' && prayerLabels !== false;

        const glyph = (
          <Text style={{ color: colour, fontSize: 9, lineHeight: 10 }}>
            {done ? '◉' : '○'}
          </Text>
        );
        const name = named ? (
          <Text
            numberOfLines={1}
            style={{
              color: colour, fontSize: 9, lineHeight: 11, fontWeight: '700',
              textDecorationLine: done ? 'line-through' : 'none',
            }}
          >
            {pr.label}
          </Text>
        ) : null;
        const time = chipMode === 'full' && prayerLabels !== false ? (
          <Text style={{ color: colour, fontSize: 8.5, lineHeight: 11, opacity: 0.8 }}>
            {formatClock(pr.minutes, clock)}
          </Text>
        ) : null;

        if (prayerStyle === 'pill') {
          return (
            <Pressable
        unstable_pressDelay={PRESS_DELAY}
              key={pr.key}
              onPress={() => onTogglePrayer?.(pr.key)}
              accessibilityRole="button"
              accessibilityLabel={`${pr.label}, ${formatClock(pr.minutes, clock)}${done ? ', prayed' : ''}`}
              hitSlop={6}
              style={{
                position: 'absolute',
                top, left: 2, right: 2, height: 16,
                flexDirection: 'row', alignItems: 'center', gap: 3,
                paddingHorizontal: 4,
                borderRadius: radius.sm,
                borderWidth: 1,
                borderColor: colour,
                // A wash of the colour rather than the colour itself: a solid
                // bar at this size competes with the events around it, which
                // are the things with actual duration.
                backgroundColor: `${colour}26`,
                opacity: done ? 0.5 : 1,
                zIndex: 3,
              }}
            >
              {glyph}
              {name}
              {time ? <View style={{ marginLeft: 'auto' }}>{time}</View> : null}
            </Pressable>
          );
        }

        const line = (
          <View style={{
            flex: 1, height: 1, backgroundColor: colour, opacity: done ? 0.4 : 0.85,
          }} />
        );
        return (
          <View
            key={pr.key}
            pointerEvents="box-none"
            style={{
              position: 'absolute',
              top: top - 8,
              left: 0, right: 0, height: 16,
              flexDirection: 'row', alignItems: 'center',
              zIndex: 3,
              opacity: done ? 0.55 : 1,
            }}
          >
            {line}
            <Pressable
        unstable_pressDelay={PRESS_DELAY}
              onPress={() => onTogglePrayer?.(pr.key)}
              hitSlop={6}
              accessibilityRole="button"
              accessibilityLabel={`${pr.label}, ${formatClock(pr.minutes, clock)}${done ? ', prayed' : ''}`}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 3,
                height: 15,
                marginHorizontal: 3,
                paddingLeft: chipMode === 'dot' ? 3 : 5,
                opacity: 1,
                paddingRight: chipMode === 'dot' ? 3 : 6,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: colour,
                // The card colour, not the grid's, so the pill reads as sitting
                // ON the line rather than as a gap in it.
                backgroundColor: p.surface,
              }}
            >
              {glyph}
              {name}
              {time}
            </Pressable>
            {line}
          </View>
        );
      })}

      {nowMin !== null ? <NowMarker top={yAt(nowMin)} /> : null}
    </Pressable>
  );
}

/**
 * Where you are in the day.
 *
 * It was a flat hairline, which on a grid already ruled with a line every few
 * minutes is one more line among fifty — the single most important thing on the
 * screen, drawn exactly like the least important. So it gets a head: a solid
 * dot on the leading edge with a halo breathing out of it once every couple of
 * seconds. Motion is what the eye finds without being asked, and nothing else
 * on this grid moves.
 *
 * The pulse runs on the native driver, so it costs nothing on the JS thread and
 * keeps going smoothly through a drag or a sync.
 */
function NowMarker({ top }: { top: number }) {
  const p = useTheme();
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(pulse, {
        toValue: 1,
        duration: 2_200,
        useNativeDriver: true,
      }),
    );
    loop.start();
    // Stopped on unmount: a loop left running holds the animation frame
    // callback alive after the column has gone.
    return () => loop.stop();
  }, [pulse]);

  return (
    <View
      pointerEvents="none"
      style={{ position: 'absolute', top: top - 5, left: 0, right: 0, height: 10 }}
    >
      <View style={{
        position: 'absolute',
        top: 4.25, left: 0, right: 0, height: 1.5,
        backgroundColor: p.danger,
      }} />
      <Animated.View
        style={{
          position: 'absolute',
          left: -7, top: -7,
          width: 24, height: 24, borderRadius: 12,
          backgroundColor: p.danger,
          opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.4, 0] }),
          transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.3, 1] }) }],
        }}
      />
      <View style={{
        position: 'absolute',
        left: -3, top: 0,
        width: 10, height: 10, borderRadius: 5,
        backgroundColor: p.danger,
      }} />
    </View>
  );
}

/**
 * The hours you chose not to draw, and what is in them.
 *
 * Sits directly under the last row of the grid, which is the only honest place
 * for it: the column ends, the timeline is broken, and what follows is
 * explicitly no longer on it. The dots are the join. They are drawn rather than
 * written because the same mark has to work under a column forty points wide
 * and under one three hundred wide, and because a row of dots reads as "the
 * story continues" in a way no wording of it does.
 *
 * Every row is still live: a prayer ticks off, an item opens. Being outside the
 * drawn hours is a display choice, and a display choice must not take anything
 * away from you.
 */
function OutsideHours({ entries, detailed }: {
  entries: readonly OutsideEntry[];
  detailed?: boolean;
}) {
  const p = useTheme();
  if (entries.length === 0) return <View style={{ flex: 1 }} />;

  return (
    <View style={{ flex: 1, paddingHorizontal: 2 }}>
      {/* The join. Three dots down the middle, in the line colour, so it reads
          as the timeline being interrupted rather than as a control. */}
      <View style={{ alignItems: 'center', paddingVertical: 5, gap: 3 }}>
        {[0, 1, 2].map(i => (
          <View
            key={i}
            style={{
              width: 3, height: 3, borderRadius: 1.5,
              backgroundColor: p.inkFaint,
              // Fading downward, so the eye travels from the grid into the list
              // rather than stopping at a row of three equal marks.
              opacity: 0.9 - i * 0.22,
            }}
          />
        ))}
      </View>

      <View style={{
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: p.line,
        borderStyle: 'dashed',
        paddingVertical: 3,
        paddingHorizontal: 3,
        gap: 2,
      }}>
        {entries.map(entry => (
          <Pressable
            unstable_pressDelay={PRESS_DELAY}
            key={entry.key}
            onPress={entry.onPress}
            disabled={!entry.onPress}
            accessibilityRole={entry.onPress ? 'button' : undefined}
            accessibilityLabel={`${entry.label}, ${entry.detail.range}, outside the hours shown`}
            style={({ pressed }) => [{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              opacity: entry.done ? 0.45 : 1,
            }, pressed ? PRESSED : null]}
          >
            {/* The item's own colour, as a bar rather than a dot: it is the
                same left edge the block on the grid would have had, so the row
                is recognisably the same thing seen from below. */}
            <View style={{
              width: 3,
              alignSelf: 'stretch',
              minHeight: detailed ? 22 : 18,
              borderRadius: 2,
              backgroundColor: entry.colour,
            }} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                numberOfLines={1}
                style={{
                  color: p.ink,
                  fontSize: detailed ? 11 : 9,
                  lineHeight: detailed ? 14 : 11,
                  fontWeight: '600',
                  textDecorationLine: entry.done ? 'line-through' : 'none',
                }}
              >
                {entry.label}
              </Text>
              <Text
                numberOfLines={1}
                style={{
                  color: p.inkFaint,
                  fontSize: detailed ? 10 : 8,
                  lineHeight: detailed ? 13 : 10,
                }}
              >
                {entry.detail.detail
                  ? `${entry.detail.range} ${entry.detail.detail}`
                  : entry.detail.range}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
