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
import type { AgendaDay } from '../../lib/agenda';

export function MonthView({
  anchor, dayOf, today, weekStartsOn, onOpenDay,
}: {
  anchor: string;
  dayOf: (date: string) => AgendaDay;
  today: string;
  weekStartsOn: number;
  onOpenDay: (date: string) => void;
}) {
  const p = useTheme();
  const { weeks, month } = useMemo(
    () => monthGrid(anchor, weekStartsOn),
    [anchor, weekStartsOn],
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
                agenda={dayOf(date)}
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

function Cell({ date, agenda, inMonth, isToday, onPress }: {
  date: string;
  agenda: AgendaDay;
  inMonth: boolean;
  isToday: boolean;
  onPress: () => void;
}) {
  const p = useTheme();
  const events = agenda.all.filter(i => i.store === 'events');
  // At most three marks: beyond that the count says it better than the dots do.
  const marks = events.slice(0, 3);
  const day = new Date(`${date}T00:00:00`).getDate();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${date}, ${events.length === 0 ? 'nothing' : `${events.length} items`}`}
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
        {marks.map(item => (
          <View
            key={item.id}
            style={{
              height: 4,
              borderRadius: 2,
              backgroundColor: item.colour ?? p.accent,
              opacity: item.completed ? 0.4 : 1,
            }}
          />
        ))}
        {events.length > 3 ? (
          <Text variant="caption" tone="faint" style={{ fontSize: 9, lineHeight: 11 }}>
            +{events.length - 3}
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}
