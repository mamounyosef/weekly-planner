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

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  PanResponder,
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
import { daysBetween } from '../lib/monthDrag';
import { shiftMonths } from '../lib/grid';
import { ItemMenu, type ItemMenuTarget } from '../ui/ItemMenu';
import { SWATCH_BASE_HEX } from '../lib/gcalColor';
import { anchorFor, describeRecur, draftFromRecord, toTimeString } from '../lib/draft';
import type { OccurrenceScope } from '../lib/occurrence';
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
  custom: 'Custom',
  week: 'Week',
  month: 'Month',
  year: 'Year',
};

/** The palette the menu offers, the same one the editor shows. */
const SWATCHES = Object.entries(SWATCH_BASE_HEX).map(([key, hex]) => ({ key, hex }));

export function Today({
  onOpenConflicts, onOpenSearch, onOpenNotifications, onOpenQuickAdd,
  goToDate, onWentToDate,
}: {
  onOpenConflicts: () => void;
  onOpenSearch?: () => void;
  onOpenNotifications?: () => void;
  onOpenQuickAdd?: () => void;
  /** A day handed over from search or the bell. Shown, then acknowledged. */
  goToDate?: string;
  onWentToDate?: () => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const {
    day, status, conflicts, syncNow, toggleDone, timeFormat, weekStartsOn, interval,
    prayersOn, isPrayerDone, togglePrayer, customWindow, events, categories,
    visibleHours, dayWindow, swipeViewSwitch, saveDraft, applyScoped, edit, tasks,
    unreadNotifications, prayerAppearance,
  } = usePlanner();

  const today = ymd(new Date());
  const [selected, setSelected] = useState(today);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState<EditorTarget | null>(null);
  const [menu, setMenu] = useState<ItemMenuTarget | null>(null);
  /**
   * Which occurrence the menu is acting on.
   *
   * Kept beside the menu rather than inside its target, because `ItemMenuTarget`
   * is deliberately a DESCRIPTION: the menu asks a question and knows nothing
   * about stores, masters or dates. The answer comes back as an id, and this is
   * what turns that id back into "which item, on which day, in which store".
   */
  const menuItemRef = useRef<AgendaItem | null>(null);

  /**
   * Which view this phone is on.
   *
   * Remembered on the DEVICE, never synced: the PC keeps `calendarView` in its
   * own per-device settings for the same reason. A phone on the day and a
   * desktop on the week is the correct state of affairs, not a disagreement.
   */
  const [view, setView] = useState<ViewMode>('day');

  /**
   * A day handed over from search or the bell.
   *
   * Acknowledged immediately so it fires once. Leaving it set would pin the
   * calendar to that day and quietly undo every swipe afterwards.
   */
  useEffect(() => {
    if (!goToDate) return;
    setSelected(goToDate);
    onWentToDate?.();
  }, [goToDate, onWentToDate]);
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

  /**
   * What a swipe moves: always "the next screenful", whatever is on screen.
   *
   * A month view that moved by one day would be a gesture that appears to do
   * nothing, since the same month is still drawn. So the unit changes with the
   * view rather than the distance changing, and month and year move by calendar
   * months and years rather than by a fixed number of days: months are not all
   * the same length, and stepping 30 days from the 31st lands in the wrong one.
   */
  const swipeStepRef = React.useRef<{ unit: 'day' | 'month' | 'year'; size: number }>({
    unit: 'day', size: 1,
  });
  swipeStepRef.current = view === 'year' ? { unit: 'year', size: 1 }
    : view === 'month' ? { unit: 'month', size: 1 }
      : view === 'week' ? { unit: 'day', size: 7 }
        : view === 'custom'
          ? { unit: 'day', size: customWindow.before + customWindow.after + 1 }
          : { unit: 'day', size: 1 };

  /**
   * Swipe sideways to move a day.
   *
   * PanResponder rather than a gesture library: this app updates over the air,
   * and a gesture library is a native module, which would end that. It is also
   * ample for one axis.
   *
   * The claim is deliberately fussy. It takes the gesture only once the finger
   * has travelled meaningfully sideways AND clearly more sideways than up, so a
   * vertical scroll through a long day is never stolen mid-flick, and neither is
   * a horizontal scroll of the chips or the date strip above.
   */
  const swipe = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > 24 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderRelease: (_e, g) => {
      if (Math.abs(g.dx) < 48) return;
      const step = g.dx < 0 ? 1 : -1;   // drag left, go forward
      const { unit, size } = swipeStepRef.current;
      setSelected(current => (unit === 'day'
        ? addDays(current, step * size)
        : shiftMonths(current, step * size * (unit === 'year' ? 12 : 1))));
    },
  }), []);

  const open = (item: AgendaItem) =>
    setEditing({ store: item.store, id: item.masterId, date: item.date });

  /**
   * Long-press anything: open the menu on it.
   *
   * The description is built here, not in the menu, so the menu stays a thing
   * that asks a question. Everything it shows (the colour, the repeat sentence,
   * whether the series is locked) comes from the record the occurrence resolves
   * to, which is the same record the actions will be planned against.
   */
  const hold = (item: AgendaItem) => {
    menuItemRef.current = item;
    const store = item.store === 'events' ? events() : tasks();
    const master = (store as any)[item.masterId] ?? {};
    setMenu({
      id: item.id,
      title: item.title,
      subtitle: item.startMin === null
        ? dayLabel(item.date, new Date())
        : `${dayLabel(item.date, new Date())}, ${formatClock(item.startMin, timeFormat)}`,
      repeats: item.repeating,
      repeatLabel: item.repeating ? describeRecur(master.recur) : undefined,
      locked: master.locked === true,
      done: item.completed,
      colour: typeof master.colour === 'string' ? master.colour : undefined,
      categoryId: item.categoryId,
      accent: item.colour,
      kind: item.store === 'events' ? 'event' : 'task',
    });
  };

  /** The occurrence the menu is on, or nothing if it closed underneath us. */
  const heldItem = (): AgendaItem | null => menuItemRef.current;

  const closeMenu = () => { setMenu(null); menuItemRef.current = null; };

  const menuEdit = async (_id: string, scope: OccurrenceScope) => {
    const item = heldItem();
    closeMenu();
    if (!item) return;
    if (scope === 'all' || !item.repeating) {
      setEditing({ store: item.store, id: item.masterId, date: item.date });
      return;
    }
    // "Only this one" and "this and everything after" both have to SPLIT the
    // series before the editor can be trusted to write to one id. Doing the
    // split first, with an empty patch, means the sheet then edits a plain
    // standalone record and every field in it behaves normally.
    const target = await applyScoped(item.store, item.masterId, item.date, scope, 'edit', {});
    if (target) setEditing({ store: item.store, id: target, date: item.date });
  };

  const menuDelete = async (_id: string, scope: OccurrenceScope) => {
    const item = heldItem();
    closeMenu();
    if (!item) return;
    await applyScoped(item.store, item.masterId, item.date, scope, 'delete');
  };

  /**
   * Duplicate lands on the SAME day, not the next free slot.
   *
   * Copying something is nearly always the first half of "and now change one
   * thing about it", so the copy opens in the editor straight away rather than
   * appearing silently underneath the original where two identical blocks
   * overlap and neither can be told apart.
   */
  const menuDuplicate = async (_id: string) => {
    const item = heldItem();
    closeMenu();
    if (!item) return;
    const store = item.store === 'events' ? events() : tasks();
    const master = (store as any)[item.masterId];
    if (!master) return;
    // Through `draftFromRecord` and back out, which is the same round trip the
    // editor makes. A shallow copy of the record would carry the Google id and
    // the sync stamps with it, and two records claiming one remote event means
    // one of them quietly stops being drawn.
    const draft = draftFromRecord(master, item.store, item.date);
    const id = await saveDraft(item.store, {
      ...draft,
      title: `${draft.title} copy`,
      // A copy of one occurrence is a single item, never a second series. The
      // alternative is one long-press silently creating a year of events.
      recur: undefined,
    });
    setEditing({ store: item.store, id, date: item.date });
  };

  const menuColour = async (_id: string, colour: string | undefined) => {
    const item = heldItem();
    closeMenu();
    if (item) await edit(item.store, item.masterId, { colour });
  };

  const menuCategory = async (_id: string, categoryId: string | undefined) => {
    const item = heldItem();
    closeMenu();
    if (item) await edit(item.store, item.masterId, { categoryId });
  };

  const menuToggleDone = (_id: string, _next: boolean) => {
    const item = heldItem();
    closeMenu();
    if (item) void tick(item);
  };

  /**
   * A stretch drawn on an empty grid IS the answer to "when", so the sheet opens
   * already holding it rather than on the next round half hour.
   */
  const createFromDrag = ({ date, startMin, endMin }: {
    date: string; startMin: number; endMin: number;
  }) => setEditing({
    store: 'events',
    date,
    prefill: { allDay: false, startMin, endMin },
  });

  /**
   * Dropping a block writes it straight through, with no sheet in between.
   *
   * A confirmation step here would make the gesture pointless: the whole value
   * of dragging an event is that it is faster than opening it. It is also
   * reversible by dragging it back, which a delete is not, so it does not need
   * the guard a destructive action does.
   *
   * A repeating occurrence is DETACHED first, honouring the same rule the PC
   * uses: moving one day of a series means that day only, unless the series is
   * locked, and `applyScoped` reads the lock itself.
   */
  const moveFromDrag = async ({ item, date, startMin, endMin }: {
    item: AgendaItem; date: string; startMin: number; endMin: number | null;
  }) => {
    const patch: Record<string, unknown> = {
      startTime: toTimeString(startMin),
      endTime: endMin === null ? undefined : toTimeString(endMin),
    };
    if (date !== item.date) {
      const anchor = anchorFor(date, weekStartsOn);
      patch.weekKey = anchor.weekKey;
      patch.dayIndex = anchor.dayIndex;
    }
    await applyScoped(
      item.store, item.masterId, item.date,
      item.repeating ? 'one' : 'all', 'edit', patch,
    );
  };

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
            <Pressable
              onPress={() => setSelected(today)}
              disabled={showingToday}
              accessibilityRole="button"
              accessibilityLabel={showingToday ? dayLabel(selected, now) : 'Back to today'}
            >
              <Text variant="display" numberOfLines={1}>{dayLabel(selected, now)}</Text>
            </Pressable>
          </View>

          {/* Only when you have wandered off. A permanent button would be a
              control that does nothing most of the time, and the title itself
              is the obvious thing to press to get back. */}
          {!showingToday ? (
            <Pressable
              onPress={() => setSelected(today)}
              accessibilityRole="button"
              accessibilityLabel="Back to today"
              hitSlop={space.sm}
              style={{
                paddingHorizontal: space.md, height: 30,
                borderRadius: radius.pill,
                alignItems: 'center', justifyContent: 'center',
                borderWidth: 1, borderColor: p.accent,
                backgroundColor: p.accentSoft,
              }}
            >
              <Text variant="caption" tone="accent" style={{ fontWeight: '700' }}>Today</Text>
            </Pressable>
          ) : null}

          {/* Settings has a tab of its own now, so the gear that used to sit
              here would be a second door to the same room. Conflicts stay,
              because they are an event rather than a place and need to be
              visible from the screen they concern. */}
          {conflicts.length > 0 ? (
            <HeaderButton glyph="◎" onPress={onOpenConflicts} a11y="Conflicts"
              badge={conflicts.length} />
          ) : null}

          {/* Search and the bell live in the header rather than on the tab bar:
              both are ways of reaching the calendar, not places beside it, and
              the bar is deliberately four wide so the tabs stay legible. */}
          {onOpenQuickAdd ? (
            <HeaderButton glyph="✎" onPress={onOpenQuickAdd} a11y="Quick add" />
          ) : null}
          {onOpenSearch ? (
            <HeaderButton glyph="⌕" onPress={onOpenSearch} a11y="Search" />
          ) : null}
          {onOpenNotifications ? (
            <HeaderButton
              glyph="◔"
              onPress={onOpenNotifications}
              a11y="Notifications"
              badge={unreadNotifications > 0 ? unreadNotifications : undefined}
            />
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
      {/* The swipe lives on the body only. Putting it on the whole screen would
          fight the horizontal strips in the header above. */}
      <View style={{ flex: 1 }} {...(swipeViewSwitch ? swipe.panHandlers : {})}>
      {view === 'week' ? (
        <WeekView
          dates={weekDates}
          dayOf={eventsOf}
          today={today}
          nowMin={weekDates.includes(today) ? nowMin : null}
          clock={timeFormat}
          interval={interval}
          prayersOn={prayerAppearance.showOnCalendar ? prayersOn : undefined}
          prayerColour={prayerAppearance.colour}
          prayerLabels={prayerAppearance.showLabels}
          prayerStyle={prayerAppearance.style}
          isPrayerDone={isPrayerDone}
          onTogglePrayer={(date, key) => { void togglePrayer(date, key); }}
          visibleHours={visibleHours}
          onCreateRange={createFromDrag}
          onMoveItem={moveFromDrag}
          onMenuItem={hold}
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
          prayersOn={prayerAppearance.showOnCalendar ? prayersOn : undefined}
          prayerColour={prayerAppearance.colour}
          prayerLabels={prayerAppearance.showLabels}
          prayerStyle={prayerAppearance.style}
          isPrayerDone={isPrayerDone}
          onTogglePrayer={(date, key) => { void togglePrayer(date, key); }}
          visibleHours={visibleHours}
          onCreateRange={createFromDrag}
          onMoveItem={moveFromDrag}
          onMenuItem={hold}
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
          prayersOn={prayerAppearance.showOnCalendar ? prayersOn : undefined}
          prayerColour={prayerAppearance.colour}
          prayerLabels={prayerAppearance.showLabels}
          prayerStyle={prayerAppearance.style}
          isPrayerDone={isPrayerDone}
          onTogglePrayer={(date, key) => { void togglePrayer(date, key); }}
          visibleHours={visibleHours}
          onCreateRange={createFromDrag}
          onMoveItem={moveFromDrag}
          onMenuItem={hold}
          onOpenItem={open}
          onOpenDay={date => { setSelected(date); chooseView('day'); }}
        />
      ) : view === 'month' ? (
        <MonthView
          anchor={selected}
          events={events()}
          categories={categories}
          today={today}
          weekStartsOn={weekStartsOn}
          onOpenDay={date => { setSelected(date); chooseView('day'); }}
          onCreateSpan={({ startDate, endDate }) => setEditing({
            store: 'events',
            date: startDate,
            // Sweeping days in the month view is a statement about WHICH DAYS,
            // so the sheet opens as an all-day item already covering them. The
            // span is inclusive: one cell is one day, not zero.
            prefill: {
              allDay: true,
              startMin: null,
              endMin: null,
              daysSpan: daysBetween(startDate, endDate) + 1,
            },
          })}
        />
      ) : view === 'year' ? (
        <YearView
          anchor={selected}
          events={events()}
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
              <ItemRow key={item.id} item={item} onTick={tick} onOpen={open} onHold={hold} clock={timeFormat} />
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
                  <ItemRow item={item} onTick={tick} onOpen={open} onHold={hold} rail clock={timeFormat} />
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
      </View>

      {/* ── Add ────────────────────────────────────────────────────────── */}
      <Pressable
        onPress={() => setEditing({ store: 'events', date: selected })}
        // The same button, held: typing one line is often faster than filling a
        // sheet, and the two belong on the same control rather than making the
        // header carry a second plus.
        onLongPress={onOpenQuickAdd}
        delayLongPress={300}
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

      <ItemMenu
        target={menu}
        onClose={closeMenu}
        onEdit={menuEdit}
        onDelete={menuDelete}
        onToggleDone={menuToggleDone}
        onDuplicate={menuDuplicate}
        onColour={menuColour}
        onCategory={menuCategory}
        categories={categories as any}
        swatches={SWATCHES}
      />
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
function ItemRow({ item, onTick, onOpen, onHold, rail, clock }: {
  item: AgendaItem;
  onTick: (item: AgendaItem) => void;
  onOpen: (item: AgendaItem) => void;
  /** Long-press: everything you can do to this without opening it. */
  onHold?: (item: AgendaItem) => void;
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
        onLongPress={onHold ? () => onHold(item) : undefined}
        delayLongPress={280}
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
