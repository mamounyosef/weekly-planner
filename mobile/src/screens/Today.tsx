// ─── The day ─────────────────────────────────────────────────────────────────
// The screen the app opens on, and the one thing it has to get right.
//
// WHAT THIS IS NOT, ANY MORE
// It used to be a single flat list: all-day items, timed items and tasks poured
// into one column in that order. Anything without a clock time showed "—" in the
// time rail, which reads as an error rather than as a fact, and tasks — which
// are half the reason to open a planner — ended up dumped below everything else
// where they looked like an afterthought. Every card also carried a row of
// chips: "Task", "Repeats", "Done". That is metadata, not design; it crowded the
// one thing a person is actually reading, which is the title.
//
// THE STRUCTURE NOW
// A day has three genuinely different kinds of thing in it, so it is drawn as
// three:
//
//   ANYTIME   all-day events and undated tasks. Things that are true of the day
//             rather than of a moment in it. No time rail at all, because there
//             is no time — the absence is the information.
//   TIMELINE  only what has a clock time, down a single rail of times, with the
//             current moment drawn across it.
//   TASKS     given their own heading and their own count, because "what do I
//             still have to do" is a different question from "what is on".
//
// Other decisions worth stating:
//
//  • DATES LIVE AT THE TOP. They were a cramped strip at the bottom, wedged
//    against the system navigation bar, with single letters and dots that
//    encoded nothing. A calendar's dates belong at its head; the strip is now
//    the header's second line and reads as a week.
//  • DURATION, NOT AN END CLOCK. The rail showed two timestamps per item, which
//    doubled its visual weight for a number nobody reads. It shows the start,
//    and "30m" underneath — the thing you actually want at a glance.
//  • DONE IS NOT DELETED. Completion was drawn as strikethrough, which is what
//    every interface uses for removed text. It is now a filled check and a
//    quieter card, which is what finishing something looks like.

import React, { useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, StatusDot, Text, useTheme } from '../ui/kit';
import { radius, space, HIT } from '../theme';
import { usePlanner } from '../state/planner';
import { Editor, type EditorTarget } from './Editor';
import { WeekView } from './views/WeekView';
import { MonthView } from './views/MonthView';
import { YearView } from './views/YearView';
import { prefs } from '../lib/prefs';
import {
  addDays,
  currentItem,
  dayLabel,
  formatClock,
  nextItem,
  ymd,
  type AgendaItem,
} from '../lib/agenda';

type ViewMode = 'agenda' | 'day' | 'custom' | 'week' | 'month' | 'year';

/** Short enough to fit six chips across a phone without wrapping. */
const VIEW_LABELS: Record<ViewMode, string> = {
  agenda: 'List',
  day: 'Day',
  custom: 'Span',
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

export function Today({ onOpenConflicts }: {
  onOpenConflicts: () => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const {
    day, status, conflicts, syncNow, toggleDone, timeFormat, weekStartsOn, interval,
    prayersOn, isPrayerDone, togglePrayer, customWindow,
  } = usePlanner();

  const today = ymd(new Date());
  const [selected, setSelected] = useState(today);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<EditorTarget | null>(null);

  /**
   * Which view this phone is on.
   *
   * Remembered on the DEVICE, never synced: the PC keeps `calendarView` in its
   * own per-device settings for the same reason. A phone on the day and a
   * desktop on the week is the correct state of affairs, not a disagreement.
   */
  const [view, setView] = useState<ViewMode>('day');
  useEffect(() => {
    void prefs.getCalendarView().then(saved => {
      const known: string[] = ['agenda', 'day', 'custom', 'week', 'month', 'year'];
      if (saved && known.includes(saved)) setView(saved as ViewMode);
    });
  }, []);
  const chooseView = (next: ViewMode) => {
    setView(next);
    void prefs.setCalendarView(next);
  };

  /**
   * The day, EVENTS ONLY.
   *
   * Tasks have a place of their own now, and showing them here as well made the
   * calendar answer two questions at once — badly, since they arrived with no
   * time and piled up at the bottom. What is ON is a different question from
   * what is TO DO, and each screen now answers exactly one of them.
   */
  const agenda = useMemo(() => {
    const full = day(selected);
    const allDay = full.allDay.filter(i => i.store === 'events');
    const timed = full.timed.filter(i => i.store === 'events');
    const all = [...allDay, ...timed];
    return {
      ...full,
      allDay,
      timed,
      tasks: [],
      all,
      counts: { total: all.length, done: all.filter(i => i.completed).length },
    };
  }, [day, selected]);

  /** Events only here too, so the strip's load bars match what the day shows. */
  const loadOf = React.useCallback((date: string) => {
    const items = day(date).all.filter(i => i.store === 'events');
    return { total: items.length, done: items.filter(i => i.completed).length };
  }, [day]);

  // A week at a time, starting three days back, so today sits just left of
  // centre and the days you are most likely to want are all reachable.
  const strip = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(selected, i - 3)),
    [selected],
  );

  /**
   * The Custom view's dates: a window around the chosen day.
   *
   * This is the view the other four cannot be. A week is a week whether or not
   * you care about the weekend, and a month is far too much; "the next four
   * days" is what a person actually plans in, and it is the only window that
   * stays useful on a narrow screen because you choose how many columns it has.
   */
  const customDates = useMemo(() => {
    const total = customWindow.before + customWindow.after + 1;
    return Array.from({ length: total }, (_, i) => addDays(selected, i - customWindow.before));
  }, [selected, customWindow]);

  /** The selected day's own week, for the week view. */
  const weekDates = useMemo(() => {
    const d = new Date(`${selected}T00:00:00`);
    const lead = ((d.getDay() - weekStartsOn) % 7 + 7) % 7;
    const start = addDays(selected, -lead);
    return Array.from({ length: 7 }, (_, i) => addDays(start, i));
  }, [selected, weekStartsOn]);

  /** Events only, for the grid views. */
  const eventsOf = React.useCallback((date: string) => {
    const full = day(date);
    const allDay = full.allDay.filter(i => i.store === 'events');
    const timed = full.timed.filter(i => i.store === 'events');
    return { ...full, allDay, timed, tasks: [], all: [...allDay, ...timed] };
  }, [day]);

  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const showingToday = selected === today;
  const running = showingToday ? currentItem(agenda, nowMin) : null;
  const upNext = showingToday ? nextItem(agenda, nowMin) : null;

  const refresh = async () => {
    setRefreshing(true);
    try { await syncNow(); } finally { setRefreshing(false); }
  };

  const statusTone =
    status.conflicts > 0 ? 'warn'
      : status.phase === 'syncing' ? 'busy'
        : status.phase === 'offline' || status.phase === 'error' ? 'offline'
          : 'ok';

  const open = (item: AgendaItem) =>
    setEditing({ store: item.store, id: item.masterId, date: item.date });

  const tick = (item: AgendaItem) => toggleDone(item.store, {
    masterId: item.masterId,
    date: item.date,
    repeating: item.repeating,
    completed: item.completed,
  });

  // All-day events: true of the day rather than of a moment in it.
  const anytime = agenda.allDay;
  const timed = agenda.timed;

  const prayers = useMemo(() => prayersOn(selected), [prayersOn, selected]);
  /** The next one still to come, for the highlight and the countdown. */
  const nextPrayer = showingToday
    ? prayers.find(pr => pr.minutes > nowMin && !isPrayerDone(selected, pr.key))
    : undefined;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>

      {/* ── Header ─────────────────────────────────────────────────────── */}
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingBottom: space.sm,
        backgroundColor: p.bg,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Row style={{
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          paddingHorizontal: space.xl,
        }}>
          <View style={{ flex: 1 }}>
            <Pressable onPress={refresh} hitSlop={space.sm}>
              <Row gap={space.sm} style={{ alignItems: 'center', marginBottom: 2 }}>
                <StatusDot tone={statusTone as any} />
                <Text variant="caption" tone={status.conflicts > 0 ? 'warn' : 'faint'}>
                  {status.label}
                </Text>
              </Row>
            </Pressable>
            <Text variant="display" numberOfLines={1}>{dayLabel(selected, now)}</Text>
          </View>

          {/* Settings has a tab of its own now, so the gear that used to sit
              here would be a second door to the same room. Conflicts stay,
              because they are an event rather than a place and need to be
              visible from the screen they concern. */}
          {conflicts.length > 0 ? (
            <HeaderButton glyph="◎" onPress={onOpenConflicts} a11y="Conflicts"
              badge={conflicts.length} />
          ) : null}
        </Row>

        {/* Day / Week / Month. Small, because it is a mode switch rather than
            an action, and it must not compete with the date itself. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{
            gap: space.xs,
            paddingHorizontal: space.xl,
            marginTop: space.sm,
          }}
        >
          {(['agenda', 'day', 'custom', 'week', 'month', 'year'] as ViewMode[]).map(mode => {
            const on = mode === view;
            return (
              <Pressable
                key={mode}
                onPress={() => chooseView(mode)}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                style={{
                  paddingHorizontal: space.md,
                  height: 30,
                  borderRadius: radius.pill,
                  alignItems: 'center',
                  justifyContent: 'center',
                  backgroundColor: on ? p.accentSoft : 'transparent',
                  borderWidth: 1,
                  borderColor: on ? p.accent : p.line,
                }}
              >
                <Text variant="caption" tone={on ? 'accent' : 'faint'}>
                  {VIEW_LABELS[mode]}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>

        {/* The strip belongs to the single-day views; the others draw their own
            dates and a second row of them would only compete. */}
        {view === 'day' || view === 'agenda' || view === 'custom' ? (
          <Row gap={0} style={{ paddingHorizontal: space.md, marginTop: space.md }}>
            {strip.map(date => (
              <DayCell
                key={date}
                date={date}
                selected={date === selected}
                isToday={date === today}
                load={loadOf(date)}
                onPress={() => setSelected(date)}
              />
            ))}
          </Row>
        ) : null}
      </View>

      {/* ── The body ───────────────────────────────────────────────────── */}
      {view === 'week' ? (
        <WeekView
          dates={weekDates}
          dayOf={eventsOf}
          today={today}
          nowMin={weekDates.includes(today) ? nowMin : null}
          clock={timeFormat}
          interval={interval}
          onOpenItem={open}
          onOpenDay={date => { setSelected(date); chooseView('day'); }}
        />
      ) : view === 'day' ? (
        // The same grid, one column wide. A day IS a time grid on the PC, and
        // the snap interval means nothing on a list, so this is where the
        // setting becomes visible.
        <WeekView
          dates={[selected]}
          dayOf={eventsOf}
          today={today}
          nowMin={showingToday ? nowMin : null}
          clock={timeFormat}
          interval={interval}
          detailed
          onOpenItem={open}
          onOpenDay={() => chooseView('agenda')}
        />
      ) : view === 'custom' ? (
        <WeekView
          dates={customDates}
          dayOf={eventsOf}
          today={today}
          nowMin={customDates.includes(today) ? nowMin : null}
          clock={timeFormat}
          interval={interval}
          detailed={customDates.length <= 2}
          onOpenItem={open}
          onOpenDay={date => { setSelected(date); chooseView('day'); }}
        />
      ) : view === 'month' ? (
        <MonthView
          anchor={selected}
          dayOf={eventsOf}
          today={today}
          weekStartsOn={weekStartsOn}
          onOpenDay={date => { setSelected(date); chooseView('day'); }}
        />
      ) : view === 'year' ? (
        <YearView
          anchor={selected}
          dayOf={eventsOf}
          today={today}
          weekStartsOn={weekStartsOn}
          onOpenMonth={date => { setSelected(date); chooseView('month'); }}
        />
      ) : (
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.xl,
          paddingTop: space.lg,
          // Clear of the floating button, which used to sit on top of the last
          // card and made it look broken.
          paddingBottom: insets.bottom + 120,
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={p.accent} />
        }
      >
        {agenda.all.length === 0 ? (
          <EmptyDay showingToday={showingToday} />
        ) : null}

        {/* Happening now / up next — the one thing worth answering instantly. */}
        {running || upNext ? (
          <Spotlight item={(running ?? upNext)!} live={Boolean(running)} onPress={open} clock={timeFormat} />
        ) : null}

        {anytime.length > 0 ? (
          <Group title="Anytime" hint="No particular time">
            {anytime.map(item => (
              <ItemRow key={item.id} item={item} onTick={tick} onOpen={open} clock={timeFormat} />
            ))}
          </Group>
        ) : null}

        {timed.length > 0 ? (
          <Group title="Timeline">
            {timed.map((item, i) => {
              const previous = timed[i - 1];
              // Drawn once, in the gap before the first thing still to come, so
              // it lands between rows instead of at a pixel offset that drifts
              // as cards resize.
              const crossesNow =
                showingToday &&
                item.startMin !== null &&
                item.startMin > nowMin &&
                (!previous || previous.startMin === null || previous.startMin <= nowMin);
              return (
                <View key={item.id}>
                  {crossesNow ? <NowLine minutes={nowMin} clock={timeFormat} /> : null}
                  <ItemRow item={item} onTick={tick} onOpen={open} rail clock={timeFormat} />
                </View>
              );
            })}
            {/* The line belongs after everything if the day is already done. */}
            {showingToday && timed.length > 0
              && timed.every(i => i.startMin !== null && i.startMin <= nowMin)
              ? <NowLine minutes={nowMin} clock={timeFormat} /> : null}
          </Group>
        ) : null}

        {prayers.length > 0 ? (
          <Group
            title="Prayers"
            hint={nextPrayer
              ? `${nextPrayer.label} in ${untilText(nextPrayer.minutes - nowMin)}`
              : undefined}
          >
            {prayers.map(pr => (
              <PrayerRow
                key={pr.id}
                prayer={pr}
                clock={timeFormat}
                done={isPrayerDone(selected, pr.key)}
                next={nextPrayer?.key === pr.key}
                past={showingToday && pr.minutes <= nowMin}
                onToggle={() => void togglePrayer(selected, pr.key)}
              />
            ))}
          </Group>
        ) : null}
      </ScrollView>
      )}

      {/* ── Add ────────────────────────────────────────────────────────── */}
      <Pressable
        onPress={() => setEditing({ store: 'events', date: selected })}
        accessibilityRole="button"
        accessibilityLabel="Add to this day"
        android_ripple={{ color: p.accentSoft, radius: 34 }}
        style={({ pressed }) => ({
          position: 'absolute',
          right: space.xl,
          bottom: insets.bottom + space.xl,
          width: 60, height: 60, borderRadius: 30,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: p.accent,
          transform: [{ scale: pressed ? 0.94 : 1 }],
          elevation: 8,
          shadowColor: '#000',
          shadowOpacity: 0.4,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 5 },
        })}
      >
        <Text variant="display" style={{ color: p.accentInk, fontSize: 32, lineHeight: 36 }}>+</Text>
      </Pressable>

      <Editor target={editing} onClose={() => setEditing(null)} />
    </View>
  );
}

// ─── Header pieces ───────────────────────────────────────────────────────────

function HeaderButton({ glyph, onPress, a11y, badge }: {
  glyph: string; onPress: () => void; a11y: string; badge?: number;
}) {
  const p = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11y}
      android_ripple={{ color: p.accentSoft, borderless: true }}
      style={{ width: HIT, height: HIT, alignItems: 'center', justifyContent: 'center' }}
    >
      <Text variant="heading" tone="soft">{glyph}</Text>
      {badge ? (
        <View style={{
          position: 'absolute', top: 6, right: 6,
          minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4,
          backgroundColor: p.warn, alignItems: 'center', justifyContent: 'center',
        }}>
          <Text variant="caption" style={{ color: p.accentInk, fontSize: 10, lineHeight: 12 }}>
            {badge}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * One day in the week strip.
 *
 * The load bar is the point of it. A row of identical dots said nothing about
 * which days are busy, so the strip was decoration; a short bar that grows with
 * the day's count means you can see the shape of your week without opening it.
 */
function DayCell({ date, selected, isToday, load, onPress }: {
  date: string;
  selected: boolean;
  isToday: boolean;
  load: { total: number; done: number };
  onPress: () => void;
}) {
  const p = useTheme();
  const d = new Date(`${date}T00:00:00`);
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' }).slice(0, 2);
  const busy = Math.min(1, load.total / 6);

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={`${d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}, ${load.total === 0 ? 'nothing planned' : `${load.total} items`}`}
      style={{
        flex: 1,
        alignItems: 'center',
        paddingVertical: space.sm,
        borderRadius: radius.md,
        backgroundColor: selected ? p.accentSoft : 'transparent',
      }}
    >
      <Text
        variant="caption"
        tone={selected ? 'accent' : 'faint'}
        style={{ fontSize: 11, letterSpacing: 0.4 }}
      >
        {weekday.toUpperCase()}
      </Text>
      <Text
        variant="bodyStrong"
        tone={selected ? 'accent' : isToday ? 'ink' : 'soft'}
        style={{ marginTop: 2, fontSize: 17 }}
      >
        {d.getDate()}
      </Text>

      {/* Today is marked by a ring under the number; busyness by the bar. */}
      <View style={{ height: 6, justifyContent: 'center', marginTop: 3 }}>
        {load.total > 0 ? (
          <View style={{
            height: 3,
            width: 6 + busy * 16,
            borderRadius: 2,
            backgroundColor: selected ? p.accent : p.inkFaint,
            opacity: selected ? 1 : 0.6,
          }} />
        ) : isToday ? (
          <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: p.accent }} />
        ) : null}
      </View>
    </Pressable>
  );
}

// ─── Day pieces ──────────────────────────────────────────────────────────────

function Group({ title, hint, hintTone = 'faint', children }: {
  title: string;
  hint?: string;
  hintTone?: 'faint' | 'ok';
  children: React.ReactNode;
}) {
  const p = useTheme();
  return (
    <View style={{ marginBottom: space.xl }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: space.sm }}>
        <Text variant="label" tone="faint" style={{ letterSpacing: 1 }}>
          {title.toUpperCase()}
        </Text>
        {hint ? (
          <Text variant="caption" style={{ color: hintTone === 'ok' ? p.ok : p.inkFaint }}>
            {hint}
          </Text>
        ) : null}
      </Row>
      <View style={{ gap: space.sm }}>{children}</View>
    </View>
  );
}

/** What is on right now, or next. The one thing worth reading from a glance. */
function Spotlight({ item, live, onPress, clock }: {
  item: AgendaItem; live: boolean; onPress: (item: AgendaItem) => void; clock?: string;
}) {
  const p = useTheme();
  return (
    <Pressable
      onPress={() => onPress(item)}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => ({
        marginBottom: space.xl,
        padding: space.lg,
        borderRadius: radius.lg,
        backgroundColor: live ? p.accentSoft : p.surface,
        borderWidth: 1,
        borderColor: live ? p.accent : p.line,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <Row gap={space.sm} style={{ alignItems: 'center', marginBottom: space.xs }}>
        {live ? <Pulse /> : null}
        <Text variant="label" tone={live ? 'accent' : 'faint'} style={{ letterSpacing: 1 }}>
          {live ? 'HAPPENING NOW' : 'UP NEXT'}
        </Text>
      </Row>
      <Text variant="title" numberOfLines={2}>{item.title}</Text>
      <Text variant="caption" tone="soft" style={{ marginTop: 4 }}>
        {item.startMin === null ? 'Any time today' : formatClock(item.startMin, clock)}
        {item.endMin !== null && item.startMin !== null
          ? `  ·  ${describeSpan(item.startMin, item.endMin)}`
          : ''}
      </Text>
    </Pressable>
  );
}

function Pulse() {
  const p = useTheme();
  return <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.accent }} />;
}

/**
 * One row of the day.
 *
 * The whole row opens the item; only the checkbox completes it. That is the
 * opposite of what it did before, where tapping anywhere ticked something off
 * and editing needed a long press nobody would guess at. Ticking is frequent but
 * it is also destructive-ish and easy to do by accident in a pocket, so it gets
 * its own target rather than the whole card.
 */
function ItemRow({ item, onTick, onOpen, rail, clock }: {
  item: AgendaItem;
  onTick: (item: AgendaItem) => void;
  onOpen: (item: AgendaItem) => void;
  rail?: boolean;
  clock?: string;
}) {
  const p = useTheme();
  const colour = item.colour ?? (item.store === 'tasks' ? p.ok : p.accent);

  return (
    <Row align="stretch" gap={space.md}>
      {rail ? (
        <View style={{ width: 46, paddingTop: space.md, alignItems: 'flex-end' }}>
          <Text variant="clock" tone={item.completed ? 'faint' : 'ink'}>
            {item.startMin === null ? '' : formatClock(item.startMin, clock)}
          </Text>
          {item.startMin !== null && item.endMin !== null ? (
            <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
              {describeSpan(item.startMin, item.endMin)}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Pressable
        onPress={() => onOpen(item)}
        android_ripple={{ color: p.accentSoft }}
        style={({ pressed }) => ({
          flex: 1,
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.md,
          paddingVertical: space.md,
          paddingRight: space.md,
          paddingLeft: space.md,
          borderRadius: radius.md,
          backgroundColor: p.surface,
          borderWidth: 1,
          borderColor: p.line,
          overflow: 'hidden',
          opacity: pressed ? 0.9 : item.completed ? 0.6 : 1,
        })}
      >
        {/* The category's own colour, the only colour on the card. */}
        <View style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colour,
        }} />

        {item.checkable ? (
          <Check
            done={item.completed}
            round={item.store === 'tasks'}
            colour={colour}
            onPress={() => onTick(item)}
            label={item.title}
          />
        ) : (
          <View style={{ width: 22 }} />
        )}

        <View style={{ flex: 1 }}>
          <Row gap={space.xs} style={{ alignItems: 'center' }}>
            <Text
              variant="bodyStrong"
              tone={item.completed ? 'faint' : 'ink'}
              numberOfLines={2}
              style={{ flexShrink: 1 }}
            >
              {item.title}
            </Text>
            {/* A repeat is worth one glyph, not a chip that says "Repeats". */}
            {item.repeating ? (
              <Text variant="caption" tone="faint" style={{ fontSize: 13 }}>↻</Text>
            ) : null}
          </Row>

          {item.notes ? (
            <Text variant="caption" tone="soft" numberOfLines={1} style={{ marginTop: 2 }}>
              {item.notes}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </Row>
  );
}

/** A tick target of its own, big enough to hit and small enough not to shout. */
function Check({ done, round, colour, onPress, label }: {
  done: boolean; round: boolean; colour: string; onPress: () => void; label: string;
}) {
  const p = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={label}
      hitSlop={space.md}
      style={{
        width: 22, height: 22,
        borderRadius: round ? 11 : 6,
        borderWidth: 2,
        borderColor: done ? colour : p.inkFaint,
        backgroundColor: done ? colour : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {done ? (
        <Text style={{ color: p.accentInk, fontSize: 13, lineHeight: 15, fontWeight: '900' }}>
          ✓
        </Text>
      ) : null}
    </Pressable>
  );
}

function NowLine({ minutes, clock }: { minutes: number; clock?: string }) {
  const p = useTheme();
  return (
    <Row gap={space.sm} style={{ alignItems: 'center', paddingVertical: space.sm }}>
      <View style={{ width: 46, alignItems: 'flex-end' }}>
        <Text variant="caption" style={{ color: p.danger, fontSize: 11 }}>
          {formatClock(minutes, clock)}
        </Text>
      </View>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: p.danger }} />
      <View style={{ flex: 1, height: 1, backgroundColor: p.danger, opacity: 0.45 }} />
    </Row>
  );
}

/**
 * One prayer.
 *
 * Its own row shape rather than an event's, because a prayer is not an
 * appointment: it has a time and no length, nobody created it, and it cannot be
 * edited. What it needs is the time, the name in both scripts, and a way to mark
 * it prayed. The next one due carries the accent, so "what is next" is answered
 * before anything is read.
 */
function PrayerRow({ prayer, clock, done, next, past, onToggle }: {
  prayer: { key: string; label: string; arabic: string; minutes: number };
  clock?: string;
  done: boolean;
  next: boolean;
  past: boolean;
  onToggle: () => void;
}) {
  const p = useTheme();

  return (
    <Pressable
      onPress={onToggle}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={`${prayer.label}, ${done ? 'prayed' : 'not yet'}`}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.md,
        paddingVertical: space.sm,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        backgroundColor: next ? p.accentSoft : p.surface,
        borderWidth: 1,
        borderColor: next ? p.accent : p.line,
        opacity: pressed ? 0.9 : done ? 0.55 : past && !next ? 0.75 : 1,
      })}
    >
      <View style={{ width: 52 }}>
        <Text variant="clock" tone={next ? 'accent' : done ? 'faint' : 'ink'}>
          {formatClock(prayer.minutes, clock)}
        </Text>
      </View>

      <View style={{ flex: 1 }}>
        <Text variant="bodyStrong" tone={done ? 'faint' : next ? 'accent' : 'ink'}>
          {prayer.label}
        </Text>
      </View>

      <Text variant="body" tone="faint" style={{ fontSize: 15 }}>{prayer.arabic}</Text>

      <View style={{
        width: 20, height: 20, borderRadius: 10,
        borderWidth: 2,
        borderColor: done ? p.ok : p.inkFaint,
        backgroundColor: done ? p.ok : 'transparent',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {done ? (
          <Text style={{ color: p.accentInk, fontSize: 11, lineHeight: 13, fontWeight: '900' }}>
            ✓
          </Text>
        ) : null}
      </View>
    </Pressable>
  );
}

/** "1h 20m", "8m". How long until something, said the short way. */
function untilText(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function EmptyDay({ showingToday }: { showingToday: boolean }) {
  return (
    <View style={{ paddingTop: space.xxl, alignItems: 'center', gap: space.sm }}>
      <Text variant="heading" tone="soft">
        {showingToday ? 'Nothing on today' : 'Nothing on this day'}
      </Text>
      <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 260 }}>
        Events you add here or on your PC meet in the middle. Tasks live on
        their own tab.
      </Text>
    </View>
  );
}

/** "30m", "1h", "1h 30m" — what you want to know, in the space of one word. */
function describeSpan(startMin: number, endMin: number): string {
  const mins = Math.max(0, endMin - startMin);
  if (mins === 0) return '';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}
