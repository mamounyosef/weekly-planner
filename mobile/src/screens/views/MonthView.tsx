// ─── Month ───────────────────────────────────────────────────────────────────
// Six weeks of cells. Not for reading a day — for finding one.
//
// A month cell on a phone is roughly fifty points square, which is enough for a
// date and two or three marks and nothing else. So the view answers "which days
// have anything, and how much" and hands over to the day view for the rest. Any
// attempt to show titles here produces four ellipsised characters per event,
// which tells you less than a dot does.
//
// SIX ROWS, ALWAYS. Months need five or six depending on where they start, and a
// grid that changes height between them makes every cell move under the thumb as
// you page through. The row count is fixed and the spare row is simply the next
// month's first days, greyed.

import React, { useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Text, useTheme } from '../../ui/kit';
import { radius, space } from '../../theme';
import { monthGrid } from '../../lib/grid';
import { countsForRange } from '../../lib/agenda';

export function MonthView({
  anchor, events, today, weekStartsOn, onOpenDay,
}: {
  anchor: string;
  events: Record<string, Record<string, unknown>>;
  today: string;
  weekStartsOn: number;
  onOpenDay: (date: string) => void;
}) {
  const p = useTheme();
  const { weeks, month } = useMemo(
    () => monthGrid(anchor, weekStartsOn),
    [anchor, weekStartsOn],
  );

  /**
   * Every cell's count, in ONE pass over the events.
   *
   * It used to build a whole agenda per cell: forty-two calls, each walking the
   * planner and expanding every repeat. That was a visible pause every time this
   * view was opened, for a grid whose cells show a number and a tint.
   */
  const counts = useMemo(
    () => countsForRange(events, weeks[0][0], weeks[5][6], weekStartsOn as any),
    [events, weeks, weekStartsOn],
  );

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

      <ScrollView contentContainerStyle={{ paddingBottom: space.xl }}>
        {weeks.map((week, wi) => (
          <View key={wi} style={{ flexDirection: 'row' }}>
            {week.map(date => (
              <Cell
                key={date}
                date={date}
                count={counts[date] ?? 0}
                inMonth={new Date(`${date}T00:00:00`).getMonth() === month}
                isToday={date === today}
                onPress={() => onOpenDay(date)}
              />
            ))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

function Cell({ date, count, inMonth, isToday, onPress }: {
  date: string;
  count: number;
  inMonth: boolean;
  isToday: boolean;
  onPress: () => void;
}) {
  const p = useTheme();
  // At most three marks: beyond that the count says it better than the bars do.
  const marks = Math.min(3, count);
  const day = new Date(`${date}T00:00:00`).getDate();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${date}, ${count === 0 ? 'nothing' : `${count} items`}`}
      android_ripple={{ color: p.accentSoft }}
      style={{
        flex: 1,
        minHeight: 74,
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
