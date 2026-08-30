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

import React, { useMemo, useRef, useEffect } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Text, useTheme } from '../../ui/kit';
import { radius, space } from '../../theme';
import { layoutDay, hourMarks, yOf } from '../../lib/grid';
import { formatClock, type AgendaDay, type AgendaItem } from '../../lib/agenda';

const RAIL = 38;

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

export function WeekView({
  dates, dayOf, today, nowMin, clock, interval = 30, detailed, onOpenItem, onOpenDay,
}: {
  dates: string[];
  dayOf: (date: string) => AgendaDay;
  today: string;
  nowMin: number | null;
  clock?: string;
  /** Snap interval in minutes. Decides the grid's resolution and its height. */
  interval?: number;
  /** One column: there is room for a title and a time inside each block. */
  detailed?: boolean;
  onOpenItem: (item: AgendaItem) => void;
  onOpenDay: (date: string) => void;
}) {
  const p = useTheme();
  const scroller = useRef<ScrollView>(null);

  const days = useMemo(() => dates.map(date => {
    const agenda = dayOf(date);
    return {
      date,
      allDay: agenda.allDay.filter(i => i.store === 'events'),
      timed: agenda.timed.filter(i => i.store === 'events' && i.startMin !== null),
    };
  }), [dates, dayOf]);

  // The window of hours worth drawing: from an hour before the earliest thing to
  // an hour after the latest, never less than a working day.
  const { fromHour, toHour } = useMemo(() => {
    let min = 9 * 60;
    let max = 18 * 60;
    for (const d of days) {
      for (const i of d.timed) {
        min = Math.min(min, i.startMin!);
        max = Math.max(max, i.endMin ?? i.startMin! + 60);
      }
    }
    return {
      fromHour: Math.max(0, Math.floor(min / 60) - 1),
      toHour: Math.min(24, Math.ceil(max / 60) + 1),
    };
  }, [days]);

  const slot = slotHeight(interval);
  const pxPerHour = slot * (60 / interval);
  const marks = hourMarks(fromHour, toHour);
  const gridHeight = (toHour - fromHour) * pxPerHour;
  const anyAllDay = days.some(d => d.allDay.length > 0);

  /** Every slot line in the visible window, in minutes from midnight. */
  const slots = useMemo(() => {
    const out: number[] = [];
    for (let m = fromHour * 60; m <= toHour * 60; m += interval) out.push(m);
    return out;
  }, [fromHour, toHour, interval]);

  useEffect(() => {
    // Start where the day does, not at the top of an empty grid.
    const target = nowMin !== null
      ? yOf(nowMin, pxPerHour, fromHour) - 120
      : 0;
    const id = setTimeout(
      () => scroller.current?.scrollTo({ y: Math.max(0, target), animated: false }),
      0,
    );
    return () => clearTimeout(id);
  }, [fromHour, nowMin, pxPerHour]);

  return (
    <View style={{ flex: 1 }}>
      {/* Day headings */}
      <View style={{ flexDirection: 'row', borderBottomWidth: 1, borderBottomColor: p.line }}>
        <View style={{ width: RAIL }} />
        {days.map(d => {
          const date = new Date(`${d.date}T00:00:00`);
          const isToday = d.date === today;
          return (
            <Pressable
              key={d.date}
              onPress={() => onOpenDay(d.date)}
              style={{ flex: 1, alignItems: 'center', paddingVertical: space.sm }}
            >
              <Text variant="caption" tone={isToday ? 'accent' : 'faint'} style={{ fontSize: 10 }}>
                {date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase()}
              </Text>
              <Text
                variant="bodyStrong"
                tone={isToday ? 'accent' : 'ink'}
                style={{ fontSize: 15 }}
              >
                {date.getDate()}
              </Text>
            </Pressable>
          );
        })}
      </View>

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

      <ScrollView ref={scroller} contentContainerStyle={{ paddingBottom: space.xxl }}>
        <View style={{ flexDirection: 'row', height: gridHeight }}>
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
                    top: yOf(m, pxPerHour, fromHour) - (onHour ? 7 : 6),
                    right: 4,
                    fontSize: onHour ? 10 : 8.5,
                    fontWeight: onHour ? '700' : '400',
                    opacity: onHour ? 1 : 0.8,
                  }}
                >
                  {onHour
                    ? formatClock(m, clock).replace(':00', '')
                    : minuteLabel(m)}
                </Text>
              );
            })}
          </View>

          {/* Columns */}
          {days.map(d => (
            <DayColumn
              key={d.date}
              items={d.timed}
              fromHour={fromHour}
              height={gridHeight}
              pxPerHour={pxPerHour}
              marks={marks}
              slots={slots}
              detailed={detailed}
              clock={clock}
              isToday={d.date === today}
              nowMin={d.date === today ? nowMin : null}
              onOpenItem={onOpenItem}
              onOpenDay={() => onOpenDay(d.date)}
            />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

/** ":05", ":30" — enough to read the subdivision without repeating the hour. */
function minuteLabel(minutes: number): string {
  return `:${String(minutes % 60).padStart(2, '0')}`;
}

function DayColumn({
  items, fromHour, height, pxPerHour, marks, slots, detailed, clock,
  isToday, nowMin, onOpenItem, onOpenDay,
}: {
  items: AgendaItem[];
  fromHour: number;
  height: number;
  pxPerHour: number;
  marks: number[];
  slots: number[];
  detailed?: boolean;
  clock?: string;
  isToday: boolean;
  nowMin: number | null;
  onOpenItem: (item: AgendaItem) => void;
  onOpenDay: () => void;
}) {
  const p = useTheme();

  const placed = useMemo(
    () => layoutDay(
      items.map(i => ({ id: i.id, startMin: i.startMin!, endMin: i.endMin, item: i })),
      { pxPerHour, dayStartHour: fromHour },
    ),
    [items, fromHour, pxPerHour],
  );

  return (
    <Pressable
      onPress={onOpenDay}
      style={{
        flex: 1,
        height,
        borderLeftWidth: 1,
        borderLeftColor: p.line,
        backgroundColor: isToday ? p.accentSoft : 'transparent',
      }}
    >
      {/* Slot lines first, then the hours over them: the hour has to stay
          readable as the stronger line however fine the slots are. */}
      {slots.map(m => (
        <View
          key={`s${m}`}
          style={{
            position: 'absolute',
            top: yOf(m, pxPerHour, fromHour),
            left: 0, right: 0,
            height: 1,
            backgroundColor: p.line,
            opacity: 0.22,
          }}
        />
      ))}
      {marks.map(h => (
        <View
          key={h}
          style={{
            position: 'absolute',
            top: yOf(h * 60, pxPerHour, fromHour),
            left: 0, right: 0,
            height: 1,
            backgroundColor: p.line,
            opacity: 0.7,
          }}
        />
      ))}

      {placed.map(pl => {
        const item = (pl.item as any).item as AgendaItem;
        const width = `${100 / pl.columns}%`;
        return (
          <Pressable
            key={item.id}
            onPress={() => onOpenItem(item)}
            style={{
              position: 'absolute',
              top: pl.top,
              height: pl.height,
              left: `${(100 / pl.columns) * pl.column}%`,
              width: width as any,
              paddingHorizontal: 1,
            }}
          >
            <View style={{
              flex: 1,
              backgroundColor: item.colour ?? p.accent,
              borderRadius: 3,
              paddingHorizontal: detailed ? 6 : 3,
              paddingTop: 1,
              opacity: item.completed ? 0.45 : 0.92,
              overflow: 'hidden',
            }}>
              <Text
                numberOfLines={detailed ? 2 : 2}
                style={{
                  color: '#fff',
                  fontSize: detailed ? 12 : 9,
                  lineHeight: detailed ? 15 : 11,
                  fontWeight: detailed ? '600' : '400',
                }}
              >
                {item.title}
              </Text>
              {detailed && pl.height > 30 ? (
                <Text style={{ color: '#fff', fontSize: 10, lineHeight: 13, opacity: 0.85 }}>
                  {formatClock(item.startMin, clock)}
                  {item.endMin !== null ? ` to ${formatClock(item.endMin, clock)}` : ''}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}

      {nowMin !== null ? (
        <View style={{
          position: 'absolute',
          top: yOf(nowMin, pxPerHour, fromHour),
          left: 0, right: 0, height: 1.5,
          backgroundColor: p.danger,
        }} />
      ) : null}
    </Pressable>
  );
}
