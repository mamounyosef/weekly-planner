// ─── Search ──────────────────────────────────────────────────────────────────
// The only way to reach something that is not near today.
//
// Paging the calendar is how you READ a plan. It is a hopeless way to find one
// item in it: a dentist appointment in four months, the lecture whose room you
// wrote in the notes, the shopping task you added weeks ago and never dated.
// Everything is already on the phone, so all of that is one string scan away,
// and this screen is what makes the scan reachable.
//
// EVERY DECISION IS IN `lib/search.ts`. Which items match, how well, which
// occurrence of a repeat to show, and what order the rows come out in are all
// settled by a pure module the PC and the phone share and that is tested on its
// own. This file is layout, gestures and a text field. That split is what stops
// the phone quietly ranking things differently from the desktop.
//
// WHAT IS ON SCREEN BEFORE ANYTHING IS TYPED
// A blank search screen wastes the most valuable moment there is: the user has
// already decided they are looking for something and has not yet said what. So
// the empty state answers the two most likely intentions without a keystroke,
// which are "what is coming up" and "what was I just working on", and offers the
// user's own categories and lists as one-tap queries.
//
// THE MATCH IS POINTED AT, NOT IMPLIED. Every row highlights the characters that
// actually matched, in the title and in a trimmed window of the note. Without
// that, a row that matched on a note or a category name looks like a mistake and
// the whole list looks untrustworthy.
//
// THE SCREEN OWNS NO DATA AND NO EDITOR. It reads the planner and calls back.
// Opening a result is the caller's job, because the caller is the screen that
// already has an editor mounted and already knows how to route an occurrence
// back to its stored master.

import React, { useDeferredValue, useMemo, useRef, useState } from 'react';
import {
  FlatList,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text as RNText,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Divider, Empty, Row, Text, useTheme } from '../ui/kit';
import { HIT, PRESSED, PRESS_DELAY, radius, space, type as typeScale } from '../theme';
import { usePlanner } from '../state/planner';
import { addDays, dayLabel, formatClock, ymd } from '../lib/agenda';
import {
  searchPlanner,
  searchPreview,
  splitHighlight,
  type SearchDone,
  type SearchHit,
  type SearchScope,
} from '../lib/search';
import { GENERAL_LIST_ID, type TaskList } from '../lib/taskLists';

/**
 * What the caller is handed when a result is tapped.
 *
 * Deliberately shaped like the editor's own target rather than like a search
 * hit: the calling screen owns the editor, and it should not have to know
 * anything about scoring or occurrence ids to open one. `date` is the occurrence
 * date, which is what an edit to a repeating item has to be scoped against, and
 * for a task with no date it is simply today, because that is the day the editor
 * opens on when there is nothing else to say.
 */
export interface SearchOpenTarget {
  store: 'events' | 'tasks';
  /** The STORED master's id, never an occurrence id. */
  id: string;
  date: string;
  repeating: boolean;
  /** True when the task has no date of its own. */
  undated: boolean;
}

/**
 * How far out a date filter reaches.
 *
 * Deliberately coarse. A date picker here would be a second screen to answer a
 * question the user is usually only guessing at, and "somewhere in the next
 * month" is what they actually mean nine times out of ten.
 */
type RangeKey = 'any' | 'today' | 'week' | 'month' | 'year' | 'past';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: 'any', label: 'Any time' },
  { key: 'today', label: 'Today' },
  { key: 'week', label: 'Next 7 days' },
  { key: 'month', label: 'Next 30 days' },
  { key: 'year', label: 'Next year' },
  { key: 'past', label: 'Past' },
];

function rangeBounds(key: RangeKey, today: string): { from?: string; to?: string } {
  switch (key) {
    case 'today': return { from: today, to: today };
    case 'week': return { from: today, to: addDays(today, 7) };
    case 'month': return { from: today, to: addDays(today, 30) };
    case 'year': return { from: today, to: addDays(today, 365) };
    // "Past" stops at yesterday rather than at today, because something still
    // due today has not happened yet and does not belong under that word.
    case 'past': return { from: addDays(today, -3650), to: addDays(today, -1) };
    default: return {};
  }
}

const SCOPES: { key: SearchScope; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'events', label: 'Events' },
  { key: 'tasks', label: 'Tasks' },
];

const STATUSES: { key: SearchDone; label: string }[] = [
  { key: 'any', label: 'Any' },
  { key: 'open', label: 'Not done' },
  { key: 'done', label: 'Done' },
];

/** How many rows are worth returning. Far more than anyone scrolls. */
const LIMIT = 150;

export function Search({ onClose, onOpenItem, onOpenDate, initialQuery }: {
  /** Leave the screen. The caller decides where "back" goes. */
  onClose: () => void;
  /** Open one result. The calling screen owns the editor. */
  onOpenItem: (target: SearchOpenTarget) => void;
  /** Optional: show a date in the calendar instead of opening the item. */
  onOpenDate?: (date: string) => void;
  initialQuery?: string;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { events, tasks, categories, taskLists, weekStartsOn, timeFormat } = usePlanner();

  const [query, setQuery] = useState(initialQuery ?? '');
  const [scope, setScope] = useState<SearchScope>('all');
  const [done, setDone] = useState<SearchDone>('any');
  const [range, setRange] = useState<RangeKey>('any');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [listId, setListId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const inputRef = useRef<TextInput>(null);

  /**
   * The query the results are computed from, one step behind the one being
   * typed.
   *
   * The search itself is a few milliseconds, but the list it produces is not
   * free to render, and React would otherwise do both between one keystroke and
   * the next. Deferring the heavy half keeps the caret responsive on the very
   * first search of a session, which is the one that has to fold the whole
   * planner's text.
   */
  const deferred = useDeferredValue(query);
  const stale = deferred !== query;

  const today = ymd(new Date());
  const now = useMemo(() => new Date(), []);

  const lists = useMemo<TaskList[]>(() => (
    (taskLists as any[])
      .filter(l => l && typeof l === 'object' && typeof l.id === 'string')
      .map(l => ({ id: l.id, name: String(l.name ?? 'Untitled'), color: String(l.color ?? '') }))
  ), [taskLists]);

  const eventMap = events();
  const taskMap = tasks();

  const bounds = rangeBounds(range, today);

  const results = useMemo(() => searchPlanner({
    query: deferred,
    events: eventMap,
    tasks: taskMap,
    today,
    weekStartsOn,
    categories: categories as any[],
    taskLists: lists,
    scope,
    done,
    categoryId,
    listId,
    from: bounds.from,
    to: bounds.to,
    limit: LIMIT,
  }), [deferred, eventMap, taskMap, today, weekStartsOn, categories, lists,
    scope, done, categoryId, listId, bounds.from, bounds.to]);

  const preview = useMemo(() => searchPreview({
    events: eventMap,
    tasks: taskMap,
    today,
    weekStartsOn,
    categories: categories as any[],
    taskLists: lists,
  }), [eventMap, taskMap, today, weekStartsOn, categories, lists]);

  const searching = results.terms.length > 0;

  // Filters that are not "everything". Counted so the button can say so, since a
  // filter left on from a previous search is the classic reason a later search
  // "finds nothing" for no visible reason.
  const activeFilters = (scope !== 'all' ? 1 : 0) + (done !== 'any' ? 1 : 0)
    + (range !== 'any' ? 1 : 0) + (categoryId ? 1 : 0) + (listId ? 1 : 0);

  const clearFilters = () => {
    setScope('all');
    setDone('any');
    setRange('any');
    setCategoryId(null);
    setListId(null);
  };

  /**
   * The categories worth offering, in the order the planner actually uses them.
   *
   * A category nothing is filed under is a filter that can only ever return an
   * empty screen, so it is left out rather than offered and punished.
   */
  const offerCategories = useMemo(() => {
    const byId = new Map((categories as any[])
      .filter(c => c && typeof c.id === 'string')
      .map(c => [c.id as string, c]));
    return preview.activeCategoryIds
      .map(id => byId.get(id))
      .filter(Boolean)
      .slice(0, 12) as Array<{ id: string; name: string; color: string }>;
  }, [categories, preview.activeCategoryIds]);

  const open = (hit: SearchHit) => {
    Keyboard.dismiss();
    onOpenItem({
      store: hit.store,
      id: hit.masterId,
      date: hit.date ?? today,
      repeating: hit.repeating,
      undated: hit.date === null,
    });
  };

  // ── The list, flattened ────────────────────────────────────────────────────
  // Section headers and rows in one array so a FlatList can virtualise the whole
  // thing. A ScrollView holding a hundred and fifty cards is a visible stutter
  // on the scroll, and the whole promise of this screen is that it keeps up.
  type ListEntry =
    | { kind: 'header'; key: string; label: string; count: number; tone: 'danger' | 'accent' | 'ink' | 'faint' }
    | { kind: 'row'; key: string; hit: SearchHit }
    | { kind: 'note'; key: string; text: string };

  const entries = useMemo<ListEntry[]>(() => {
    const out: ListEntry[] = [];
    if (!searching) {
      if (preview.upcoming.length) {
        out.push({ kind: 'header', key: 'h-up', label: 'Coming up', count: preview.upcoming.length, tone: 'accent' });
        for (const hit of preview.upcoming) out.push({ kind: 'row', key: `up-${hit.id}`, hit });
      }
      if (preview.recent.length) {
        out.push({ kind: 'header', key: 'h-recent', label: 'Recently changed', count: preview.recent.length, tone: 'faint' });
        for (const hit of preview.recent) out.push({ kind: 'row', key: `re-${hit.id}`, hit });
      }
      return out;
    }

    for (const group of results.groups) {
      const tone = group.key === 'overdue' ? 'danger'
        : group.key === 'today' ? 'accent'
        : group.key === 'done' || group.key === 'past' || group.key === 'undated' ? 'faint'
        : 'ink';
      out.push({ kind: 'header', key: `h-${group.key}`, label: group.label, count: group.hits.length, tone });
      for (const hit of group.hits) out.push({ kind: 'row', key: hit.id, hit });
    }
    if (results.truncated) {
      out.push({
        kind: 'note',
        key: 'more',
        text: `Showing the best ${results.hits.length}. Add another word to narrow it down.`,
      });
    }
    return out;
  }, [searching, preview, results]);

  const summary = searching
    ? results.counts.total === 0
      ? 'No matches'
      : `${results.counts.total} ${results.counts.total === 1 ? 'result' : 'results'}`
        + (results.counts.events && results.counts.tasks
          ? `, ${results.counts.events} in the calendar and ${results.counts.tasks} in tasks`
          : '')
    : 'Search every event and task, dated or not';

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>

      {/* ── The field itself, and nothing above it ──────────────────────── */}
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.lg,
        paddingBottom: space.sm,
        backgroundColor: p.bg,
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: p.line,
      }}>
        <Row gap={space.sm}>
          <Pressable
        unstable_pressDelay={PRESS_DELAY}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close search"
            hitSlop={space.sm}
            android_ripple={{ color: p.accentSoft, borderless: true, radius: 22 }}
            style={{ width: 40, height: HIT, alignItems: 'center', justifyContent: 'center' }}
          >
            <RNText style={{ color: p.inkSoft, fontSize: 22 }}>‹</RNText>
          </Pressable>

          <View style={{
            flex: 1,
            flexDirection: 'row',
            alignItems: 'center',
            gap: space.sm,
            backgroundColor: p.surface,
            borderRadius: radius.pill,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: p.line,
            paddingHorizontal: space.lg,
            minHeight: HIT,
          }}>
            <RNText style={{ color: p.inkFaint, fontSize: 15 }}>⌕</RNText>
            <TextInput
              ref={inputRef}
              value={query}
              onChangeText={setQuery}
              placeholder="Find anything"
              placeholderTextColor={p.inkFaint}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="search"
              onSubmitEditing={Keyboard.dismiss}
              // The planner is written in two languages and the field must not
              // guess which one this is: alignment follows the text itself.
              style={[typeScale.body, {
                flex: 1, color: p.ink, paddingVertical: space.sm, writingDirection: 'auto',
              }]}
            />
            {query ? (
              <Pressable
        unstable_pressDelay={PRESS_DELAY}
      style={({ pressed }) => (pressed ? PRESSED : null)}
                onPress={() => { setQuery(''); inputRef.current?.focus(); }}
                accessibilityRole="button"
                accessibilityLabel="Clear the search"
                hitSlop={space.md}
              >
                <RNText style={{ color: p.inkFaint, fontSize: 17 }}>✕</RNText>
              </Pressable>
            ) : null}
          </View>
        </Row>

        {/* One line that always says what is being looked at. */}
        <Row style={{ justifyContent: 'space-between', marginTop: space.sm, paddingLeft: 48 }}>
          <Text variant="caption" tone={stale ? 'faint' : 'soft'} style={{ flex: 1 }} numberOfLines={1}>
            {summary}
          </Text>
        </Row>

        {/* ── Filters ──────────────────────────────────────────────────────
            The scope is always visible, because "events or tasks" is the one
            people reach for constantly. Everything else lives behind one button
            that says how many filters are on, so a filter can never be quietly
            responsible for an empty screen. */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: space.xs, paddingTop: space.sm, paddingLeft: 48 }}
        >
          {SCOPES.map(s => (
            <Chip
              key={s.key}
              label={s.label}
              on={scope === s.key}
              onPress={() => setScope(s.key)}
            />
          ))}
          <View style={{ width: 1, backgroundColor: p.line, marginHorizontal: space.xs }} />
          <Chip
            label={activeFilters ? `Filters ${activeFilters}` : 'Filters'}
            on={filtersOpen || activeFilters > 0}
            onPress={() => setFiltersOpen(v => !v)}
          />
          {activeFilters > 0 ? (
            <Chip label="Clear" on={false} onPress={clearFilters} />
          ) : null}
        </ScrollView>

        {filtersOpen ? (
          <View style={{ paddingTop: space.md, gap: space.sm }}>
            <FilterRow label="When">
              {RANGES.map(r => (
                <Chip key={r.key} label={r.label} on={range === r.key} onPress={() => setRange(r.key)} />
              ))}
            </FilterRow>
            <FilterRow label="Status">
              {STATUSES.map(s => (
                <Chip key={s.key} label={s.label} on={done === s.key} onPress={() => setDone(s.key)} />
              ))}
            </FilterRow>
            {offerCategories.length ? (
              <FilterRow label="Category">
                <Chip label="Any" on={categoryId === null} onPress={() => setCategoryId(null)} />
                {offerCategories.map(c => (
                  <Chip
                    key={c.id}
                    label={c.name}
                    colour={c.color}
                    on={categoryId === c.id}
                    onPress={() => setCategoryId(categoryId === c.id ? null : c.id)}
                  />
                ))}
              </FilterRow>
            ) : null}
            {lists.length > 1 ? (
              <FilterRow label="Task list">
                <Chip label="Any" on={listId === null} onPress={() => setListId(null)} />
                {lists.map(l => (
                  <Chip
                    key={l.id}
                    label={l.name}
                    colour={l.color}
                    on={listId === l.id}
                    onPress={() => setListId(listId === l.id ? null : l.id)}
                  />
                ))}
              </FilterRow>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* ── Results ──────────────────────────────────────────────────────── */}
      <FlatList
        data={entries}
        keyExtractor={e => e.key}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingTop: space.md,
          paddingBottom: insets.bottom + space.xxl * 2,
          gap: space.sm,
        }}
        // Enough to fill a tall phone without measuring, so the first paint of a
        // long result list is never a blank screen followed by a jump.
        initialNumToRender={14}
        windowSize={7}
        removeClippedSubviews
        ListHeaderComponent={
          !searching && (preview.upcoming.length || preview.recent.length)
            ? <Suggestions
                categories={offerCategories}
                lists={lists}
                onPick={name => { setQuery(name); inputRef.current?.focus(); }}
              />
            : null
        }
        ListEmptyComponent={
          searching
            ? <NoResults
                query={results.query}
                activeFilters={activeFilters}
                onClearFilters={clearFilters}
              />
            : <Empty
                title="Nothing to show yet"
                hint="Once the planner has synced, what is coming up will appear here."
              />
        }
        renderItem={({ item }) => {
          if (item.kind === 'header') {
            return (
              <Row style={{ justifyContent: 'space-between', paddingTop: space.md, paddingBottom: 2 }}>
                <Text variant="label" tone={item.tone}>{item.label}</Text>
                <Text variant="caption" tone="faint">{item.count}</Text>
              </Row>
            );
          }
          if (item.kind === 'note') {
            return (
              <Text variant="caption" tone="faint" style={{ textAlign: 'center', paddingVertical: space.lg }}>
                {item.text}
              </Text>
            );
          }
          return (
            <ResultRow
              hit={item.hit}
              now={now}
              clock={timeFormat}
              onPress={() => open(item.hit)}
              onPressDate={onOpenDate && item.hit.date
                ? () => { Keyboard.dismiss(); onOpenDate(item.hit.date as string); }
                : undefined}
            />
          );
        }}
      />
    </View>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

/** A filter chip. `colour` paints the dot a category or list carries. */
function Chip({ label, on, onPress, colour }: {
  label: string;
  on: boolean;
  onPress: () => void;
  colour?: string;
}) {
  const p = useTheme();
  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      android_ripple={{ color: p.accentSoft }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: space.xs,
        height: 32,
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        backgroundColor: on ? p.accentSoft : p.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: on ? p.accent : p.line,
      }}
    >
      {colour ? (
        <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: colour }} />
      ) : null}
      <RNText
        numberOfLines={1}
        style={[typeScale.caption, { color: on ? p.accent : p.inkSoft, fontWeight: '600' }]}
      >
        {label}
      </RNText>
    </Pressable>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: space.xs }}>
      <Text variant="label" tone="faint">{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: space.xs, paddingRight: space.lg }}
      >
        {children}
      </ScrollView>
    </View>
  );
}

/**
 * One-tap queries built from the user's own planner.
 *
 * A search box with no history is intimidating in a way that has nothing to do
 * with the search: you have to invent the word. These chips hand back the words
 * the planner is actually organised by, so the first tap always finds something.
 */
function Suggestions({ categories, lists, onPick }: {
  categories: Array<{ id: string; name: string; color: string }>;
  lists: TaskList[];
  onPick: (name: string) => void;
}) {
  const picks = [
    ...categories.slice(0, 4).map(c => ({ key: `c-${c.id}`, name: c.name, colour: c.color })),
    ...lists.filter(l => l.id !== GENERAL_LIST_ID).slice(0, 3)
      .map(l => ({ key: `l-${l.id}`, name: l.name, colour: l.color })),
  ];
  if (!picks.length) return null;

  return (
    <View style={{ gap: space.xs, paddingBottom: space.sm }}>
      <Text variant="label" tone="faint">Start here</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: space.xs, paddingRight: space.lg }}
      >
        {picks.map(pick => (
          <Chip key={pick.key} label={pick.name} colour={pick.colour} on={false}
            onPress={() => onPick(pick.name)} />
        ))}
      </ScrollView>
    </View>
  );
}

/**
 * Nothing found.
 *
 * Never just "no results". The two real reasons are a filter left on from the
 * last search and a word that is not in the planner, and the panel says which
 * one it can rule out and offers the fix for the other.
 */
function NoResults({ query, activeFilters, onClearFilters }: {
  query: string;
  activeFilters: number;
  onClearFilters: () => void;
}) {
  const p = useTheme();
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxl, gap: space.md }}>
      <Text variant="heading" tone="soft">Nothing matches that</Text>
      <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 280 }}>
        {activeFilters > 0
          ? 'Some filters are narrowing this down. Clearing them searches the whole planner.'
          : `Nothing in the planner contains "${query.trim()}". Try a shorter word, or part of a note.`}
      </Text>
      {activeFilters > 0 ? (
        <Pressable
        unstable_pressDelay={PRESS_DELAY}
          onPress={onClearFilters}
          accessibilityRole="button"
          android_ripple={{ color: p.accentSoft }}
          style={{
            minHeight: 40,
            paddingHorizontal: space.xl,
            borderRadius: radius.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: p.accentSoft,
          }}
        >
          <RNText style={[typeScale.bodyStrong, { color: p.accent }]}>Clear the filters</RNText>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * One result.
 *
 * A row has to be identifiable WITHOUT opening it, or the search has only moved
 * the paging problem one screen along. So it carries the date and time, the
 * category or list it is filed under, whether it repeats, whether it is done,
 * and, when the match was not in the title, the piece of text that did match.
 */
function ResultRow({ hit, now, clock, onPress, onPressDate }: {
  hit: SearchHit;
  now: Date;
  clock: string | undefined;
  onPress: () => void;
  /** Optional: jump to the day in the calendar rather than opening the item. */
  onPressDate?: () => void;
}) {
  const p = useTheme();
  const colour = hit.colour ?? (hit.store === 'tasks' ? p.ok : p.accent);

  // The meta line, assembled from whatever this item actually has. An empty
  // separator between two absent facts is the difference between a considered
  // row and a template.
  const when = hit.date === null
    ? 'No date'
    : hit.allDay || hit.startMin === null
      ? dayLabel(hit.date, now)
      : `${dayLabel(hit.date, now)}, ${formatClock(hit.startMin, clock)}`;

  const filedUnder = hit.categoryName
    ?? (hit.listName && hit.listId !== GENERAL_LIST_ID ? hit.listName : undefined);

  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${hit.title}, ${when}`}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: space.md,
        padding: space.md,
        paddingLeft: space.lg,
        borderRadius: radius.md,
        backgroundColor: p.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: p.line,
        overflow: 'hidden',
        opacity: pressed ? 0.9 : hit.completed ? 0.62 : 1,
      })}
    >
      {/* The item's own colour, the only colour on the card. */}
      <View style={{
        position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: colour,
      }} />

      <View style={{ flex: 1, gap: 3 }}>
        <Row gap={space.xs} style={{ alignItems: 'center' }}>
          <RNText
            numberOfLines={2}
            style={[typeScale.bodyStrong, {
              color: hit.completed ? p.inkFaint : p.ink,
              flexShrink: 1,
              textDecorationLine: hit.completed ? 'line-through' : 'none',
            }]}
          >
            <Highlighted text={hit.title} ranges={hit.titleRanges} />
          </RNText>
          {/* A repeat is worth one glyph, not a chip that says "Repeats". */}
          {hit.repeating ? (
            <RNText style={[typeScale.caption, { color: p.inkFaint, fontSize: 13 }]}>↻</RNText>
          ) : null}
        </Row>

        <Row gap={space.xs} style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <Pressable
        unstable_pressDelay={PRESS_DELAY}
      style={({ pressed }) => (pressed ? PRESSED : null)}
            onPress={onPressDate}
            disabled={!onPressDate}
            hitSlop={space.xs}
            accessibilityRole={onPressDate ? 'button' : undefined}
          >
            <RNText style={[typeScale.caption, {
              color: hit.bucket === 'overdue' ? p.danger : p.inkSoft,
              fontWeight: '600',
            }]}>
              {when}
            </RNText>
          </Pressable>

          {filedUnder ? (
            <>
              <RNText style={[typeScale.caption, { color: p.inkFaint }]}>·</RNText>
              <Row gap={4} style={{ alignItems: 'center' }}>
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: colour }} />
                <RNText numberOfLines={1} style={[typeScale.caption, { color: p.inkFaint }]}>
                  {filedUnder}
                </RNText>
              </Row>
            </>
          ) : null}

          {hit.completed ? (
            <>
              <RNText style={[typeScale.caption, { color: p.inkFaint }]}>·</RNText>
              <RNText style={[typeScale.caption, { color: p.ok, fontWeight: '600' }]}>Done</RNText>
            </>
          ) : null}
        </Row>

        {/* The reason the row is here, when the reason is not its title. */}
        {hit.snippet ? (
          <RNText numberOfLines={2} style={[typeScale.caption, { color: p.inkSoft }]}>
            <Highlighted text={hit.snippet} ranges={hit.snippetRanges} />
          </RNText>
        ) : hit.field === 'category' || hit.field === 'list' ? (
          <RNText style={[typeScale.caption, { color: p.inkFaint }]}>
            {hit.field === 'category' ? 'Matched the category name' : 'Matched the list name'}
          </RNText>
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * The matched characters, actually marked.
 *
 * The ranges are computed against the ORIGINAL text by the search module, which
 * is the whole reason folding keeps an index map: "café" matched by "cafe" has
 * to underline the é, not the character that happens to sit at that offset.
 */
function Highlighted({ text, ranges }: { text: string; ranges: { start: number; end: number }[] }) {
  const p = useTheme();
  if (!ranges.length) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, ranges).map((part, i) => (
        part.hit
          ? (
            <RNText
              key={i}
              style={{ color: p.accent, fontWeight: '700', backgroundColor: p.accentSoft }}
            >
              {part.text}
            </RNText>
          )
          : <RNText key={i}>{part.text}</RNText>
      ))}
    </>
  );
}
