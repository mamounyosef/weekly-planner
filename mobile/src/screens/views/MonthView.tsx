// ─── Month ───────────────────────────────────────────────────────────────────
// Six weeks of cells. Not for reading a day — for finding one, and for sweeping
// out a range of days to block off.
//
// A month cell on a phone is roughly fifty points square, which is enough for a
// date and two or three marks and nothing else. So the view answers "which days
// have anything, and how much" and hands over to the day view for the rest. Any
// attempt to show titles here produces four ellipsised characters per event,
// which tells you less than a dot does.
//
// THE ONE EXCEPTION IS THINGS THAT OCCUPY DAYS. A trip from the 3rd to the 7th
// drawn as three unrelated marks in three cells does not read as one thing; it
// reads as three separate somethings. All-day and multi-day items are therefore
// drawn as BANDS running across the cells they cover, continuous across the week
// boundary, and only what is left over is counted as marks.
//
// SIX ROWS, ALWAYS. Months need five or six depending on where they start, and a
// grid that changes height between them makes every cell move under the thumb as
// you page through. The row count is fixed and the spare row is simply the next
// month's first days, greyed.
//
// DRAGGING, WITHOUT A GESTURE LIBRARY
// Press and hold a cell, then drag: the swept range highlights as one object and
// on release the caller is handed `{ startDate, endDate }`. This is plain
// `PanResponder` on purpose. A native gesture library would be one more binary
// dependency, and a binary dependency is the end of over-the-air updates for
// this app, which is not a price worth paying for a drag.
//
// The negotiation is the delicate part. The cells are `Pressable`s and a tap
// must keep opening the day exactly as it did before, so this view never claims
// the touch on contact. It only WATCHES the touch through the capture phase,
// starts a hold timer, and takes the responder away from the cell once the hold
// has elapsed and the finger actually moves. Before that, everything belongs to
// the cell and to the scroll view, so tapping and scrolling are untouched.

import React, { useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, ScrollView, View } from 'react-native';

import { Text, useTheme } from '../../ui/kit';
import { PRESS_DELAY, radius, space } from '../../theme';
import { monthGrid } from '../../lib/grid';
import { countsForRange } from '../../lib/agenda';
import type { EventCategory } from '../../lib/categories';
import { inkOn } from '../../lib/gcalColor';
import {
  dateAtPoint,
  describeSpan,
  layoutSpans,
  spanBetween,
  spansForRange,
  type DaySpan,
  type MonthSpan,
} from '../../lib/monthDrag';

/** How long the finger must sit still before a drag is even possible. Shorter
 *  than this and an ordinary tap that wobbles turns into a range. */
const HOLD_MS = 280;
/** How far the finger may drift during the hold before it counts as a scroll. */
const HOLD_SLOP = 10;

const ROWS = 6;
const COLS = 7;

/** One lane of bands, and the band drawn inside it. */
const BAND_ROW = 15;
const BAND_H = 12;
/** Where the first lane starts, measured under the date number. */
const BAND_TOP = 21;

export function MonthView({
  anchor, events, today, weekStartsOn, onOpenDay, onCreateSpan, categories,
}: {
  anchor: string;
  events: Record<string, Record<string, unknown>>;
  today: string;
  weekStartsOn: number;
  onOpenDay: (date: string) => void;
  /** Called when the user sweeps a range of cells. Absent means no dragging at
   *  all, and the view behaves exactly as it did before. */
  onCreateSpan?: (span: { startDate: string; endDate: string }) => void;
  /** Only used to resolve a band's colour, the same way the day view does. */
  categories?: EventCategory[];
}) {
  const p = useTheme();
  const { weeks, month } = useMemo(
    () => monthGrid(anchor, weekStartsOn),
    [anchor, weekStartsOn],
  );

  /**
   * Every cell's count, and every band, in ONE pass each over the events.
   *
   * It used to build a whole agenda per cell: forty-two calls, each walking the
   * planner and expanding every repeat. That was a visible pause every time this
   * view was opened, for a grid whose cells show a number and a tint. The bands
   * follow the same rule and are read out of the store once, here, never per
   * cell and never per row.
   */
  const counts = useMemo(
    () => countsForRange(events, weeks[0][0], weeks[5][6], weekStartsOn as any),
    [events, weeks, weekStartsOn],
  );

  const { spans, covered } = useMemo(
    () => spansForRange(events, weeks[0][0], weeks[5][6], weekStartsOn as any, categories),
    [events, weeks, weekStartsOn, categories],
  );

  const layout = useMemo(() => layoutSpans<MonthSpan>(spans, weeks), [spans, weeks]);

  /** The bands of each week row, so a row renders its own without scanning. */
  const bandsByWeek = useMemo(() => {
    const out: (typeof layout.placements)[] = weeks.map(() => []);
    for (const pl of layout.placements) out[pl.weekIndex].push(pl);
    return out;
  }, [layout, weeks]);

  const headings = useMemo(() => {
    // Taken from a real week so the names follow the user's own locale and the
    // chosen first day, rather than a hardcoded English list starting on Sunday.
    const base = new Date(`${weeks[0][0]}T00:00:00`);
    return Array.from({ length: 7 }, (_, i) => {
      const d = new Date(base);
      d.setDate(d.getDate() + i);
      return d.toLocaleDateString(undefined, { weekday: 'narrow' });
    });
  }, [weeks]);

  // ─── The sweep ─────────────────────────────────────────────────────────────
  // State is what gets painted; the refs are what the gesture reads. The gesture
  // handlers are created once and must never close over a stale `weeks`, so
  // everything they need lives behind a ref that is refreshed on every render.

  const [selection, setSelection] = useState<DaySpan | null>(null);
  const [dragging, setDragging] = useState(false);

  const gridRef = useRef<View | null>(null);
  const originRef = useRef({ x: 0, y: 0, width: 0, height: 0 });
  const weeksRef = useRef(weeks);
  weeksRef.current = weeks;
  const onCreateRef = useRef(onCreateSpan);
  onCreateRef.current = onCreateSpan;

  const holdRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downRef = useRef({ x: 0, y: 0 });
  const anchorRef = useRef<string | null>(null);
  const selectionRef = useRef<DaySpan | null>(null);
  /** The hold elapsed: the cell is highlighted and a drag may now begin. */
  const armedRef = useRef(false);
  /** We own the touch: the cell's own press handlers must stay out of it. */
  const activeRef = useRef(false);

  const setSpan = (next: DaySpan | null) => {
    selectionRef.current = next;
    setSelection(prev => {
      // Never re-render on an identical range. The move handler fires on every
      // pixel and most of those pixels are inside the cell already selected.
      if (prev === next) return prev;
      if (prev && next && prev.startDate === next.startDate && prev.endDate === next.endDate) return prev;
      return next;
    });
  };

  const clearHold = () => {
    if (holdRef.current) clearTimeout(holdRef.current);
    holdRef.current = null;
  };

  const reset = () => {
    clearHold();
    armedRef.current = false;
    activeRef.current = false;
    anchorRef.current = null;
    setSpan(null);
    setDragging(false);
  };

  const dateFromPage = (pageX: number, pageY: number) => {
    const o = originRef.current;
    if (o.width <= 0 || o.height <= 0) return null;
    return dateAtPoint(pageX - o.x, pageY - o.y, weeksRef.current, {
      width: o.width, height: o.height, rows: ROWS, cols: COLS,
    });
  };

  /**
   * The hold elapsed. Measure the grid HERE rather than at layout time: the grid
   * sits in a scroll view, so its position on screen is only known for certain
   * at the moment the finger is on it.
   */
  const arm = (pageX: number, pageY: number) => {
    const node = gridRef.current as unknown as { measureInWindow?: Function } | null;
    if (!node || typeof node.measureInWindow !== 'function') return;
    node.measureInWindow((x: number, y: number, width: number, height: number) => {
      originRef.current = { x, y, width, height };
      const date = dateFromPage(pageX, pageY);
      if (!date) return;
      anchorRef.current = date;
      armedRef.current = true;
      setSpan({ startDate: date, endDate: date });
    });
  };

  const pan = useMemo(() => PanResponder.create({
    // Capture, and always decline. Watching the touch without claiming it is
    // what lets the cell underneath keep its ripple and its tap.
    onStartShouldSetPanResponderCapture: e => {
      if (!onCreateRef.current) return false;
      const { pageX, pageY } = e.nativeEvent;
      downRef.current = { x: pageX, y: pageY };
      armedRef.current = false;
      activeRef.current = false;
      clearHold();
      holdRef.current = setTimeout(() => arm(pageX, pageY), HOLD_MS);
      return false;
    },

    // Once armed, the first real movement takes the touch away from the cell and
    // from the scroll view. Before that, a drift means the user is scrolling, so
    // the hold is abandoned and this view stays out of the way.
    onMoveShouldSetPanResponderCapture: (_e, g) => {
      if (!onCreateRef.current) return false;
      if (armedRef.current) return true;
      if (Math.abs(g.dx) > HOLD_SLOP || Math.abs(g.dy) > HOLD_SLOP) clearHold();
      return false;
    },

    onPanResponderGrant: () => {
      activeRef.current = true;
      setDragging(true);
    },

    onPanResponderMove: (_e, g) => {
      const start = anchorRef.current;
      if (!start) return;
      const date = dateFromPage(g.moveX, g.moveY);
      if (!date) return;
      setSpan(spanBetween(start, date));
    },

    onPanResponderRelease: () => {
      const span = selectionRef.current;
      const create = onCreateRef.current;
      reset();
      if (span && create) create({ startDate: span.startDate, endDate: span.endDate });
    },

    onPanResponderTerminate: () => reset(),
    // Nothing may take the touch back mid-sweep; the scroll view asks.
    onPanResponderTerminationRequest: () => false,
    onShouldBlockNativeResponder: () => true,
  }), []);

  /**
   * The finger left the glass while the cell still owned the touch.
   *
   * Deferred by a tick on purpose. When the pan responder is about to take over,
   * the cell is terminated FIRST and granted second, so reading `activeRef` in
   * the same tick would see a drag that has not started yet and cancel it.
   */
  const endTouch = () => {
    clearHold();
    const wasArmed = armedRef.current;
    const span = selectionRef.current;
    setTimeout(() => {
      if (activeRef.current) return;
      const create = onCreateRef.current;
      reset();
      // Held in place and let go: that is a one day block, which is the fastest
      // way to mark off a single day and costs nothing to offer.
      if (wasArmed && span && create) create({ startDate: span.startDate, endDate: span.endDate });
    }, 0);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={{
        flexDirection: 'row',
        paddingVertical: space.xs,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        {headings.map((h, i) => (
          <View key={i} style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="caption" tone="faint" style={{ fontSize: 10 }}>{h}</Text>
          </View>
        ))}
      </View>

      <ScrollView
        scrollEnabled={!dragging}
        contentContainerStyle={{ paddingBottom: space.xl }}
      >
        <View ref={gridRef} collapsable={false} {...pan.panHandlers}>
          {weeks.map((week, wi) => {
            const lanes = layout.lanesPerWeek[wi] ?? 0;
            return (
              <View key={wi} style={{ flexDirection: 'row', position: 'relative' }}>
                {week.map(date => (
                  <Cell
                    key={date}
                    date={date}
                    // Only what is NOT already drawn as a band, so a three day
                    // trip is one band rather than a band plus three marks.
                    count={Math.max(0, (counts[date] ?? 0) - (covered[date] ?? 0))}
                    total={counts[date] ?? 0}
                    reserve={lanes * BAND_ROW}
                    inMonth={new Date(`${date}T00:00:00`).getMonth() === month}
                    isToday={date === today}
                    onPress={() => {
                      // An armed or active touch is a sweep, not a tap.
                      if (armedRef.current || activeRef.current) return;
                      onOpenDay(date);
                    }}
                    onPressOut={endTouch}
                  />
                ))}

                {/* Bands sit above the cells and never take a touch, so the
                    cell underneath still opens its day when tapped. */}
                <View pointerEvents="none" style={StyleFill}>
                  {bandsByWeek[wi].map(pl => (
                    <Band
                      key={`${pl.item.id}:${pl.weekIndex}`}
                      startCol={pl.startCol}
                      endCol={pl.endCol}
                      startsHere={pl.startsHere}
                      endsHere={pl.endsHere}
                      lane={pl.lane}
                      title={pl.item.title}
                      colour={pl.item.colour || p.accent}
                    />
                  ))}
                </View>

                {/* The sweep, drawn over everything, full cell height so the
                    swept days read as one block rather than a row of chips. */}
                {selection ? (
                  <SelectionBand week={week} span={selection} />
                ) : null}
              </View>
            );
          })}
        </View>
      </ScrollView>

      {/* What you are about to create, spelled out. Once the range runs off the
          end of a week row you cannot count the highlighted cells, so the dates
          and the length are said in words instead. */}
      {dragging && selection ? (
        <View pointerEvents="none" style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: space.lg,
          alignItems: 'center',
        }}>
          <View style={{
            backgroundColor: p.accent,
            paddingHorizontal: space.md,
            paddingVertical: space.xs,
            borderRadius: radius.pill,
            alignItems: 'center',
          }}>
            <Text variant="bodyStrong" style={{ color: p.accentInk, fontSize: 13 }}>
              {describeSpan(selection)}
            </Text>
            <Text variant="caption" style={{ color: p.accentInk, opacity: 0.75, fontSize: 10 }}>
              Release to create an all day event
            </Text>
          </View>
        </View>
      ) : null}
    </View>
  );
}

const StyleFill = {
  position: 'absolute' as const,
  left: 0,
  right: 0,
  top: 0,
  bottom: 0,
};

/** Columns are laid out with `flex: 1`, so a band is positioned in percentages
 *  of the row. That is what keeps it continuous across the cell borders instead
 *  of stopping a hair short at each one. */
function colStyle(startCol: number, endCol: number) {
  return {
    left: `${(startCol / COLS) * 100}%` as const,
    width: `${((endCol - startCol + 1) / COLS) * 100}%` as const,
  };
}

function Band({
  startCol, endCol, startsHere, endsHere, lane, title, colour,
}: {
  startCol: number;
  endCol: number;
  startsHere: boolean;
  endsHere: boolean;
  lane: number;
  title: string;
  colour: string;
}) {
  // Only the REAL ends are rounded. A band cut by the end of a week row is left
  // square there, so the eye carries it onto the next row as the same object.
  const r = radius.sm;
  return (
    <View
      style={{
        position: 'absolute',
        top: BAND_TOP + lane * BAND_ROW,
        height: BAND_H,
        ...colStyle(startCol, endCol),
        paddingHorizontal: 4,
        marginLeft: startsHere ? 3 : 0,
        marginRight: endsHere ? 3 : 0,
        backgroundColor: colour,
        justifyContent: 'center',
        borderTopLeftRadius: startsHere ? r : 0,
        borderBottomLeftRadius: startsHere ? r : 0,
        borderTopRightRadius: endsHere ? r : 0,
        borderBottomRightRadius: endsHere ? r : 0,
      }}
    >
      <Text
        numberOfLines={1}
        style={{ fontSize: 9, lineHeight: 11, fontWeight: '700', color: inkOn(colour) }}
      >
        {title}
      </Text>
    </View>
  );
}

/**
 * The swept range, on one week row.
 *
 * Deliberately a single view spanning the whole run rather than one per cell:
 * the point of the gesture is that you are selecting ONE thing, and a row of
 * separate squares says the opposite.
 */
function SelectionBand({ week, span }: { week: string[]; span: DaySpan }) {
  const p = useTheme();
  const first = week[0];
  const last = week[week.length - 1];
  if (span.endDate < first || span.startDate > last) return null;

  let startCol = 0;
  let endCol = week.length - 1;
  for (let i = 0; i < week.length; i += 1) if (week[i] >= span.startDate) { startCol = i; break; }
  for (let i = week.length - 1; i >= 0; i -= 1) if (week[i] <= span.endDate) { endCol = i; break; }

  const startsHere = span.startDate >= first;
  const endsHere = span.endDate <= last;
  const r = radius.md;

  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute',
        top: 2,
        bottom: 2,
        ...colStyle(startCol, endCol),
        backgroundColor: p.accentSoft,
        borderColor: p.accent,
        borderTopWidth: 2,
        borderBottomWidth: 2,
        borderLeftWidth: startsHere ? 2 : 0,
        borderRightWidth: endsHere ? 2 : 0,
        borderTopLeftRadius: startsHere ? r : 0,
        borderBottomLeftRadius: startsHere ? r : 0,
        borderTopRightRadius: endsHere ? r : 0,
        borderBottomRightRadius: endsHere ? r : 0,
      }}
    />
  );
}

function Cell({ date, count, total, reserve, inMonth, isToday, onPress, onPressOut }: {
  date: string;
  /** Items not already drawn as a band. */
  count: number;
  /** Everything on the day, for the spoken label. */
  total: number;
  /** Vertical room the bands of this week need above the marks. */
  reserve: number;
  inMonth: boolean;
  isToday: boolean;
  onPress: () => void;
  onPressOut: () => void;
}) {
  const p = useTheme();
  // At most three marks: beyond that the count says it better than the bars do.
  const marks = Math.min(3, count);
  const day = new Date(`${date}T00:00:00`).getDate();

  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={onPress}
      onPressOut={onPressOut}
      accessibilityRole="button"
      accessibilityLabel={`${date}, ${total === 0 ? 'nothing' : `${total} items`}`}
      accessibilityHint="Opens the day. Hold and drag across days to block off a range."
      android_ripple={{ color: p.accentSoft }}
      style={{
        flex: 1,
        minHeight: 74 + reserve,
        padding: 4,
        borderWidth: 0.5,
        borderColor: p.line,
        backgroundColor: isToday ? p.accentSoft : 'transparent',
        opacity: inMonth ? 1 : 0.35,
      }}
    >
      <Text
        variant="caption"
        tone={isToday ? 'accent' : 'ink'}
        style={{ fontSize: 12, fontWeight: isToday ? '800' : '500' }}
      >
        {day}
      </Text>

      {/* Kept clear for the bands, which are drawn over the whole row rather
          than inside any one cell. */}
      <View style={{ height: reserve }} />

      <View style={{ gap: 2, marginTop: 3 }}>
        {Array.from({ length: marks }, (_, i) => (
          <View
            key={i}
            style={{
              height: 4,
              borderRadius: 2,
              backgroundColor: p.accent,
              opacity: 1 - i * 0.22,
            }}
          />
        ))}
        {count > 3 ? (
          <Text variant="caption" tone="faint" style={{ fontSize: 9, lineHeight: 11 }}>
            +{count - 3}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

// `inkOn` now lives in `lib/gcalColor.ts`, imported above. It was written here
// first and kept here, which is how the week view came to draw the same event
// in unreadable white while this one drew it correctly. One copy, one answer.
