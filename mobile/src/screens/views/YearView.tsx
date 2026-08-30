// ─── Year ────────────────────────────────────────────────────────────────────
// Twelve months at once. The only view whose job is orientation rather than
// detail: where am I in the year, which stretches are full, when is the gap.
//
// A day here is about eleven points across, which is too small for a mark and
// far too small for a target. So a day is TINTED rather than dotted — its
// background carries how busy it is — and the tap target is the month, which
// opens the month view. Anything smaller would be a control nobody can hit.
//
// The heat scale is deliberately coarse: four steps, not a gradient. A gradient
// over a year of squares reads as noise, and the question here is only "busy or
// not", asked twelve months at a time.

import React, { useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Text, useTheme } from '../../ui/kit';
import { radius, space } from '../../theme';
import { monthGrid } from '../../lib/grid';
import type { AgendaDay } from '../../lib/agenda';

export function YearView({
  anchor, dayOf, today, weekStartsOn, onOpenMonth,
}: {
  anchor: string;
  dayOf: (date: string) => AgendaDay;
  today: string;
  weekStartsOn: number;
  onOpenMonth: (date: string) => void;
}) {
  const p = useTheme();
  const year = Number(anchor.slice(0, 4)) || new Date().getFullYear();

  const months = useMemo(
    () => Array.from({ length: 12 }, (_, m) => `${year}-${String(m + 1).padStart(2, '0')}-01`),
    [year],
  );

  return (
    <ScrollView contentContainerStyle={{ padding: space.md, paddingBottom: space.xxl }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {months.map(first => (
          <MiniMonth
            key={first}
            first={first}
            dayOf={dayOf}
            today={today}
            weekStartsOn={weekStartsOn}
            onPress={() => onOpenMonth(first)}
          />
        ))}
      </View>
    </ScrollView>
  );
}

function MiniMonth({ first, dayOf, today, weekStartsOn, onPress }: {
  first: string;
  dayOf: (date: string) => AgendaDay;
  today: string;
  weekStartsOn: number;
  onPress: () => void;
}) {
  const p = useTheme();
  const { weeks, month } = useMemo(
    () => monthGrid(first, weekStartsOn),
    [first, weekStartsOn],
  );
  const name = new Date(`${first}T00:00:00`)
    .toLocaleDateString(undefined, { month: 'short' });
  const hasToday = weeks.flat().includes(today)
    && new Date(`${today}T00:00:00`).getMonth() === month;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={new Date(`${first}T00:00:00`)
        .toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
      android_ripple={{ color: p.accentSoft }}
      style={{
        width: '33.33%',
        padding: 4,
      }}
    >
      <View style={{
        padding: space.xs,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: hasToday ? p.accent : 'transparent',
        backgroundColor: hasToday ? p.accentSoft : 'transparent',
      }}>
        <Text
          variant="caption"
          tone={hasToday ? 'accent' : 'soft'}
          style={{ fontSize: 11, fontWeight: '700', marginBottom: 3 }}
        >
          {name}
        </Text>

        {weeks.map((week, wi) => (
          <View key={wi} style={{ flexDirection: 'row' }}>
            {week.map(date => {
              const inMonth = new Date(`${date}T00:00:00`).getMonth() === month;
              const count = inMonth
                ? dayOf(date).all.filter(i => i.store === 'events').length
                : 0;
              const isToday = date === today;
              return (
                <View
                  key={date}
                  style={{
                    flex: 1,
                    aspectRatio: 1,
                    margin: 0.5,
                    borderRadius: 1.5,
                    backgroundColor: !inMonth
                      ? 'transparent'
                      : isToday
                        ? p.accent
                        : heat(count, p.accent, p.line),
                  }}
                />
              );
            })}
          </View>
        ))}
      </View>
    </Pressable>
  );
}

/**
 * Four steps, not a gradient.
 *
 * Opacity rather than separate colours, so a busy day and a quiet one are
 * obviously the same KIND of thing at different strengths — and so the whole
 * scale still works when the accent is changed.
 */
function heat(count: number, accent: string, empty: string): string {
  if (count <= 0) return empty;
  if (count <= 2) return withAlpha(accent, 0.3);
  if (count <= 4) return withAlpha(accent, 0.6);
  return accent;
}

function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return hex;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
