// ─── Focus ───────────────────────────────────────────────────────────────────
// How the time actually went, which is a different question from what was
// planned — and the only screen here that looks backwards.
//
// WHAT IT SHOWS AND WHY
// A total is not an answer on its own; the useful thing is the shape. So the
// screen leads with one number for the range, then the days as bars, because a
// week of ragged bars and a week of even ones mean completely different things
// and no total distinguishes them. Empty days are drawn as empty rather than
// skipped: a chart with the gaps closed up reads as unbroken work.
//
// The chart is plain Views, not a charting library. Seven to thirty-one bars in
// a column need layout, not a rendering engine, and a dependency here would have
// to be a native one — which would mean this screen could only ever reach the
// phone as a whole new APK instead of over the air.
//
// The maths lives in `focusStats.ts`, shared with the PC, so the two can never
// disagree about yesterday.

import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Text, useTheme } from '../ui/kit';
import { radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import {
  dateKey,
  describeDuration,
  summariseFocus,
  type FocusSessionRecord,
} from '../lib/focusStats';

type Range = 'week' | 'month' | 'year';

const RANGES: { id: Range; label: string; days: number }[] = [
  { id: 'week', label: 'Week', days: 7 },
  { id: 'month', label: 'Month', days: 30 },
  { id: 'year', label: 'Year', days: 365 },
];

export function Focus() {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { focusSessions, shared, syncNow } = usePlanner();

  const [range, setRange] = useState<Range>('week');
  const [refreshing, setRefreshing] = useState(false);

  const dayStartHour = typeof (shared as any).focusDayStartHour === 'number'
    ? (shared as any).focusDayStartHour
    : 0;

  const summary = useMemo(() => {
    const days = RANGES.find(r => r.id === range)!.days;
    const to = new Date();
    const from = new Date(to.getTime() - (days - 1) * 86_400_000);
    return summariseFocus(focusSessions as FocusSessionRecord[], {
      from: dateKey(from),
      to: dateKey(to),
      dayStartHour,
    });
  }, [focusSessions, range, dayStartHour]);

  const refresh = async () => {
    setRefreshing(true);
    try { await syncNow(); } finally { setRefreshing(false); }
  };

  const peak = summary.bestDay?.seconds ?? 0;
  // A year of daily bars is unreadable on a phone, so the long ranges show the
  // last stretch in detail rather than a smear of hairlines.
  const bars = range === 'year' ? summary.days.slice(-52) : summary.days;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Text variant="caption" tone="faint">HOW THE TIME WENT</Text>
        <Text variant="display">Focus</Text>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          paddingBottom: insets.bottom + space.xxl,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.accent} />
        }
      >
        {/* Range picker */}
        <Row
          gap={0}
          style={{
            backgroundColor: p.surfaceAlt,
            borderRadius: radius.md,
            padding: 3,
            borderWidth: 1,
            borderColor: p.line,
            marginBottom: space.xl,
          }}
        >
          {RANGES.map(r => {
            const on = r.id === range;
            return (
              <Pressable
                key={r.id}
                onPress={() => setRange(r.id)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={{
                  flex: 1, height: 38, alignItems: 'center', justifyContent: 'center',
                  borderRadius: radius.sm,
                  backgroundColor: on ? p.accent : 'transparent',
                }}
              >
                <Text variant="bodyStrong" style={{ color: on ? p.accentInk : p.inkSoft }}>
                  {r.label}
                </Text>
              </Pressable>
            );
          })}
        </Row>

        {summary.sessions === 0 ? (
          <View style={{ paddingTop: space.xxl, alignItems: 'center', gap: space.sm }}>
            <Text variant="heading" tone="soft">No focus time yet</Text>
            <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 280 }}>
              Sessions you run on your PC turn up here once they sync.
            </Text>
          </View>
        ) : (
          <>
            {/* The headline. One number, big, with the rest as support. */}
            <View style={{ marginBottom: space.xl }}>
              <Text variant="label" tone="faint" style={{ letterSpacing: 1 }}>
                {range === 'week' ? 'THIS WEEK' : range === 'month' ? 'LAST 30 DAYS' : 'LAST YEAR'}
              </Text>
              <Text
                variant="display"
                style={{ fontSize: 44, lineHeight: 50, marginTop: 2, color: p.accent }}
              >
                {describeDuration(summary.totalSeconds)}
              </Text>
              <Text variant="caption" tone="soft" style={{ marginTop: 2 }}>
                {summary.sessions} session{summary.sessions === 1 ? '' : 's'}
              </Text>
            </View>

            <Chart days={bars} peak={peak} compact={range !== 'week'} />

            <Row gap={space.sm} style={{ marginTop: space.xl }}>
              <Stat label="Average day" value={describeDuration(summary.averageSeconds)}
                hint="over days you worked" />
              <Stat label="Best day" value={describeDuration(summary.bestDay?.seconds ?? 0)}
                hint={summary.bestDay ? niceDate(summary.bestDay.date) : undefined} />
            </Row>

            <Row gap={space.sm} style={{ marginTop: space.sm }}>
              <Stat
                label="Streak"
                value={summary.streak === 0 ? 'None' : `${summary.streak} day${summary.streak === 1 ? '' : 's'}`}
                hint={summary.streak === 0 ? 'nothing today yet' : 'in a row, up to today'}
              />
              <Stat
                label="Days worked"
                value={`${summary.days.filter(d => d.seconds > 0).length}`}
                hint={`of ${summary.days.length}`}
              />
            </Row>
          </>
        )}
      </ScrollView>
    </View>
  );
}

/**
 * The days as bars.
 *
 * Height is relative to the best day in the range rather than to a fixed scale,
 * because the question is "how did this day compare with my others", not "how
 * many hours is that" — the number is already stated above.
 */
function Chart({ days, peak, compact }: {
  days: { date: string; seconds: number }[];
  peak: number;
  compact: boolean;
}) {
  const p = useTheme();
  const H = 120;
  const today = dateKey(new Date());

  return (
    <View>
      <View style={{
        height: H,
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: compact ? 2 : 6,
      }}>
        {days.map(d => {
          const ratio = peak > 0 ? d.seconds / peak : 0;
          const isToday = d.date === today;
          return (
            <View key={d.date} style={{ flex: 1, alignItems: 'center', justifyContent: 'flex-end' }}>
              <View
                style={{
                  width: '100%',
                  // A worked day never rounds to invisible: the floor is what
                  // separates "a little" from "none at all".
                  height: d.seconds > 0 ? Math.max(4, ratio * H) : 2,
                  borderRadius: 3,
                  backgroundColor: d.seconds === 0
                    ? p.line
                    : isToday ? p.accent : p.accentSoft,
                  borderWidth: d.seconds > 0 && !isToday ? 1 : 0,
                  borderColor: p.accent,
                }}
              />
            </View>
          );
        })}
      </View>

      {/* Labels only where they can be read. */}
      {!compact ? (
        <Row gap={6} style={{ marginTop: space.sm }}>
          {days.map(d => (
            <View key={d.date} style={{ flex: 1, alignItems: 'center' }}>
              <Text
                variant="caption"
                tone={d.date === today ? 'accent' : 'faint'}
                style={{ fontSize: 11 }}
              >
                {new Date(`${d.date}T00:00:00`)
                  .toLocaleDateString(undefined, { weekday: 'narrow' })}
              </Text>
            </View>
          ))}
        </Row>
      ) : (
        <Row style={{ justifyContent: 'space-between', marginTop: space.sm }}>
          <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
            {niceDate(days[0]?.date)}
          </Text>
          <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>today</Text>
        </Row>
      )}
    </View>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  const p = useTheme();
  return (
    <View style={{
      flex: 1,
      padding: space.md,
      borderRadius: radius.md,
      backgroundColor: p.surface,
      borderWidth: 1,
      borderColor: p.line,
    }}>
      <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>{label}</Text>
      <Text variant="title" style={{ marginTop: 2 }}>{value}</Text>
      {hint ? (
        <Text variant="caption" tone="faint" style={{ fontSize: 11, marginTop: 1 }}>{hint}</Text>
      ) : null}
    </View>
  );
}

function niceDate(date: string | undefined): string {
  if (!date) return '';
  return new Date(`${date}T00:00:00`)
    .toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
