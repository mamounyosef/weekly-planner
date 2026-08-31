// ─── The notification centre ─────────────────────────────────────────────────
// The phone's answer to "what did I miss, and what is about to happen".
//
// ONE TIMELINE, NOT TWO LISTS. A reminder that fired an hour ago and one due in
// an hour are the same kind of thing to a person, and splitting them into two
// tabs makes you check both to answer one question. So this is a single list
// running oldest to newest, grouped by day, with a "Now" line across it. The
// past reads as history and the future reads as a plan, and the seam between
// them is a horizontal rule rather than a navigation decision.
//
// THIS SCREEN IS NOT THE REMINDERS SCREEN. `Reminders.tsx` is settings: how
// early things alert, how loudly, which hours are quiet. This is the live list.
// The two are deliberately worded so they can never be confused: that one talks
// about rules, this one only ever talks about actual reminders, and the only
// link between them is the one line at the bottom.
//
// IT OWNS NO STATE THAT MATTERS. Everything shown is computed by
// `notifyCentre.ts` and handed in as `view`; every action is a callback. The
// screen keeps exactly two pieces of local state, the filter and which row is
// expanded, because neither survives leaving the screen and neither is worth
// syncing.
//
// OPENING THIS SCREEN DOES NOT MARK ANYTHING READ. That is a deliberate
// decision, made in `notifyCentre.ts` and repeated here because it is the thing
// a future reader will most want to change. The list is opened to see what is
// coming at least as often as to triage what arrived, and silently zeroing the
// badge would destroy the only record that something fired while the phone was
// in a pocket. Reading is always an explicit act: a tap, a swipe, or the
// "Mark all read" control.

import React, { useMemo, useRef, useState } from 'react';
import {
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Card, Divider, Row, Text, useTheme } from '../ui/kit';
import { Segment } from '../ui/Fields';
import { HIT, radius, space, type as typeScale } from '../theme';
import { formatClock } from '../lib/agenda';
import {
  KIND_LABEL,
  emptyMessage,
  filterView,
  relativeLabel,
  snoozeLabel,
  statusLine,
  type CentreEntry,
  type CentreFilter,
  type CentreView,
} from '../lib/notifyCentre';

export interface NotificationsProps {
  /** The whole list, already built. This screen never computes it. */
  view: CentreView;
  /** Fixed for one render, so every row agrees about what "now" means. */
  now: number;
  /** The user's own snooze lengths, in minutes. */
  snoozeOptions: number[];
  /** One line about what the phone currently has armed with the OS. */
  alarmSummary: string;
  /** '12h' or '24h', from the PC. */
  timeFormat?: string;
  /** This phone's own id, so a decision taken elsewhere can be named as such. */
  deviceId?: string;
  /** Set while decisions have not reached the PC yet. Reassurance, not an error. */
  pendingNote?: string | null;
  onClose: () => void;
  onRead: (keys: string[]) => void;
  onUnread: (keys: string[]) => void;
  onDismiss: (keys: string[]) => void;
  onSnooze: (keys: string[], minutes: number) => void;
  onComplete: (keys: string[]) => void;
  onClear: (keys: string[]) => void;
  onMarkAllRead: () => void;
  /** Jump to the day the reminder belongs to. */
  onOpen?: (entry: CentreEntry) => void;
  /** Opens the reminder SETTINGS, which are a different thing entirely. */
  onOpenSettings?: () => void;
}

/** How far a row must travel before the swipe counts. */
const SWIPE_THRESHOLD = 88;

/** A symbol per kind. Drawn as text because a font is not a native module. */
const KIND_GLYPH: Record<string, string> = {
  event: '◆',
  task: '✓',
  'task-digest': '≡',
  prayer: '✹',
};

const clockOf = (at: number, timeFormat: string | undefined): string => {
  const d = new Date(at);
  return formatClock(d.getHours() * 60 + d.getMinutes(), timeFormat);
};

export function Notifications(props: NotificationsProps) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const [filter, setFilter] = useState<CentreFilter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const shown = useMemo(
    () => filterView(props.view, filter, props.now),
    [props.view, filter, props.now],
  );
  const empty = useMemo(() => emptyMessage(shown, filter), [shown, filter]);

  // The "Now" line goes before the first row that has not happened yet. When
  // everything is in the past it belongs at the very bottom, which is where a
  // person's eye already is after scrolling.
  const nowKey = shown.entries[shown.nowIndex]?.key ?? null;
  const nowAtEnd = shown.entries.length > 0 && shown.nowIndex >= shown.entries.length;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      {/* ── Header ── */}
      <View style={{
        paddingTop: insets.top + space.md,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
      }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <View style={{ flex: 1 }}>
            <Row gap={space.sm}>
              <Text variant="title">Notifications</Text>
              {props.view.unread > 0 ? (
                <View style={{
                  backgroundColor: props.view.unreadCritical > 0 ? p.danger : p.accent,
                  minWidth: 22,
                  paddingHorizontal: 7,
                  paddingVertical: 2,
                  borderRadius: radius.pill,
                }}>
                  <Text variant="caption" tone="onAccent" style={{ fontWeight: '700', textAlign: 'center' }}>
                    {props.view.unread > 99 ? '99+' : String(props.view.unread)}
                  </Text>
                </View>
              ) : null}
            </Row>
            <Text variant="caption" tone="faint">{headline(props.view, props.now)}</Text>
          </View>
          <Pressable
            onPress={props.onClose}
            accessibilityLabel="Close notifications"
            style={{ width: HIT, height: HIT, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Text variant="title" tone="soft">{'✕'}</Text>
          </Pressable>
        </Row>
      </View>

      {/* ── Filter and the one bulk action ── */}
      <View style={{ paddingHorizontal: space.xl, paddingBottom: space.md, gap: space.sm }}>
        <Segment
          options={[
            { key: 'all', label: 'All' },
            { key: 'unread', label: props.view.unread > 0 ? `Unread ${props.view.unread}` : 'Unread' },
            { key: 'upcoming', label: 'Coming up' },
          ]}
          value={filter}
          onChange={setFilter}
        />
        {props.view.unread > 0 ? (
          <Pressable
            onPress={props.onMarkAllRead}
            style={{ minHeight: 36, justifyContent: 'center' }}
            accessibilityLabel="Mark everything that has fired as read"
          >
            <Text variant="caption" tone="accent">
              Mark all read, leaving what is still to come
            </Text>
          </Pressable>
        ) : null}
      </View>

      <Divider />

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space.lg,
          paddingTop: space.md,
          paddingBottom: insets.bottom + space.xxl * 2,
        }}
      >
        {shown.groups.length === 0 ? (
          <View style={{ paddingTop: space.xxl * 1.5, paddingHorizontal: space.lg, alignItems: 'center', gap: space.sm }}>
            {/* A reassuring empty state, never a shrug: it says what the phone
                is still holding for you, which is the actual worry. */}
            <View style={{
              width: 64, height: 64, borderRadius: 32,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: p.accentSoft,
            }}>
              <Text variant="title" tone="accent">{'✓'}</Text>
            </View>
            <Text variant="heading" tone="soft">{empty.title}</Text>
            <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 280 }}>
              {empty.hint}
            </Text>
          </View>
        ) : null}

        {shown.groups.map(group => (
          <View key={group.id} style={{ marginBottom: space.lg }}>
            <Row style={{ paddingHorizontal: space.sm, paddingBottom: space.sm }} gap={space.sm}>
              <Text
                variant="label"
                tone={group.relative === 'today' ? 'accent' : 'faint'}
              >
                {group.label}
              </Text>
              <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: p.line }} />
              {group.unread > 0 ? (
                <Text variant="caption" tone="accent">{group.unread} new</Text>
              ) : null}
            </Row>

            {group.items.map(entry => (
              <View key={entry.key}>
                {entry.key === nowKey ? <NowLine /> : null}
                <SwipeRow
                  entry={entry}
                  now={props.now}
                  timeFormat={props.timeFormat}
                  deviceId={props.deviceId}
                  expanded={expanded === entry.key}
                  snoozeOptions={props.snoozeOptions}
                  onToggle={() => setExpanded(expanded === entry.key ? null : entry.key)}
                  onRead={props.onRead}
                  onUnread={props.onUnread}
                  onDismiss={props.onDismiss}
                  onSnooze={props.onSnooze}
                  onComplete={props.onComplete}
                  onClear={props.onClear}
                  onOpen={props.onOpen}
                />
              </View>
            ))}
          </View>
        ))}

        {nowAtEnd ? <NowLine /> : null}

        {/* ── The footer: what the phone is holding, and where the rules live ── */}
        <View style={{ paddingHorizontal: space.sm, paddingTop: space.lg, gap: space.xs }}>
          <Text variant="caption" tone="faint">{props.alarmSummary}</Text>
          {props.pendingNote ? (
            <Text variant="caption" tone="faint">{props.pendingNote}</Text>
          ) : null}
          {props.onOpenSettings ? (
            <Pressable onPress={props.onOpenSettings} style={{ minHeight: 40, justifyContent: 'center' }}>
              <Text variant="caption" tone="accent">
                Change how early reminders arrive
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </View>
  );
}

/** The line between what has happened and what has not. */
function NowLine() {
  const p = useTheme();
  return (
    <Row gap={space.sm} style={{ paddingVertical: space.sm, paddingHorizontal: space.sm }}>
      <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: p.accent }} />
      <Text variant="label" tone="accent">Now</Text>
      <View style={{ flex: 1, height: StyleSheet.hairlineWidth, backgroundColor: p.accent, opacity: 0.5 }} />
    </Row>
  );
}

// ─── One row ─────────────────────────────────────────────────────────────────

interface RowProps {
  entry: CentreEntry;
  now: number;
  timeFormat?: string;
  deviceId?: string;
  expanded: boolean;
  snoozeOptions: number[];
  onToggle: () => void;
  onRead: (keys: string[]) => void;
  onUnread: (keys: string[]) => void;
  onDismiss: (keys: string[]) => void;
  onSnooze: (keys: string[], minutes: number) => void;
  onComplete: (keys: string[]) => void;
  onClear: (keys: string[]) => void;
  onOpen?: (entry: CentreEntry) => void;
}

/**
 * Swipe left to dismiss, swipe right to snooze.
 *
 * Both gestures are also plain buttons in the expanded row, because a swipe is
 * undiscoverable and this screen is used half asleep. The gesture only claims
 * the touch once it is clearly horizontal, so the list still scrolls normally,
 * and it is written with the core Animated and PanResponder APIs on purpose:
 * a gesture library would be a native module, and a native module would end
 * over-the-air updates for this app.
 */
function SwipeRow(props: RowProps) {
  const p = useTheme();
  const { entry } = props;
  const dx = useRef(new Animated.Value(0)).current;
  const [hint, setHint] = useState<'none' | 'dismiss' | 'snooze'>('none');

  const settle = () => {
    setHint('none');
    Animated.spring(dx, { toValue: 0, useNativeDriver: true, bounciness: 4 }).start();
  };

  const responder = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_e, g) =>
      Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
    onPanResponderMove: (_e, g) => {
      dx.setValue(g.dx);
      setHint(g.dx < -SWIPE_THRESHOLD ? 'dismiss' : g.dx > SWIPE_THRESHOLD ? 'snooze' : 'none');
    },
    onPanResponderRelease: (_e, g) => {
      if (g.dx < -SWIPE_THRESHOLD) {
        props.onDismiss([entry.key]);
      } else if (g.dx > SWIPE_THRESHOLD) {
        props.onSnooze([entry.key], props.snoozeOptions[0] ?? 10);
      }
      settle();
    },
    onPanResponderTerminate: settle,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [entry.key, props.snoozeOptions]);

  const accent = entry.color
    ?? (entry.priority === 'critical' ? p.danger : entry.status === 'upcoming' ? p.inkFaint : p.accent);
  const muted = entry.dismissed || entry.completed;

  return (
    <View style={{ marginBottom: space.sm }}>
      {/* What the swipe is about to do, revealed underneath the card. */}
      <View style={{
        position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
        flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
        paddingHorizontal: space.lg,
      }}>
        <Text variant="caption" tone={hint === 'snooze' ? 'accent' : 'faint'}>
          Snooze {snoozeLabel(props.snoozeOptions[0] ?? 10)}
        </Text>
        <Text variant="caption" tone={hint === 'dismiss' ? 'danger' : 'faint'}>Dismiss</Text>
      </View>

      <Animated.View style={{ transform: [{ translateX: dx }] }} {...responder.panHandlers}>
        <Card
          accent={accent}
          onPress={props.onToggle}
          style={{
            padding: space.md,
            opacity: muted ? 0.55 : 1,
            backgroundColor: entry.unread ? p.surfaceAlt : p.surface,
          }}
        >
          <Row align="flex-start" gap={space.md}>
            {/* The time column. Fixed width so the list reads as a timeline
                rather than as a stack of cards of different shapes. */}
            <View style={{ width: 52, alignItems: 'flex-start' }}>
              <Text variant="clock" tone={entry.status === 'upcoming' ? 'faint' : 'soft'}>
                {clockOf(entry.at, props.timeFormat)}
              </Text>
              <Text variant="caption" tone="faint" style={{ fontSize: 11 }}>
                {KIND_GLYPH[entry.kind] ?? ''} {KIND_LABEL[entry.kind]}
              </Text>
            </View>

            <View style={{ flex: 1 }}>
              <Row gap={space.sm} align="flex-start">
                <Text
                  variant={entry.unread ? 'bodyStrong' : 'body'}
                  numberOfLines={2}
                  style={{ flex: 1 }}
                >
                  {entry.title}
                </Text>
                {entry.unread ? (
                  <View style={{
                    width: 8, height: 8, borderRadius: 4, marginTop: 6,
                    backgroundColor: entry.priority === 'critical' ? p.danger : p.accent,
                  }} />
                ) : null}
              </Row>

              {entry.body ? (
                <Text variant="caption" tone="soft" numberOfLines={2}>{entry.body}</Text>
              ) : null}

              <Text variant="caption" tone="faint">{statusLine(entry, props.now)}</Text>

              <ChipRow entry={entry} deviceId={props.deviceId} />

              {props.expanded ? (
                <Actions {...props} />
              ) : null}
            </View>
          </Row>
        </Card>
      </Animated.View>
    </View>
  );
}

/** Only the chips that say something the time line does not. */
function ChipRow({ entry, deviceId }: { entry: CentreEntry; deviceId?: string }) {
  const p = useTheme();
  const chips: Array<{ text: string; colour: string }> = [];

  if (entry.priority === 'critical') chips.push({ text: 'Critical', colour: p.danger });
  if (entry.completed) chips.push({ text: 'Done', colour: p.ok });
  else if (entry.dismissed) chips.push({ text: 'Dealt with', colour: p.inkFaint });
  if (entry.snoozeCount > 1) chips.push({ text: `Snoozed ${entry.snoozeCount} times`, colour: p.warn });
  if (entry.orphan) chips.push({ text: 'Item since removed', colour: p.inkFaint });
  // Named rather than assumed: the decision may have come from the PC, or from
  // a second phone, and claiming the wrong one is worse than staying vague.
  if (entry.read && entry.readBy && deviceId && entry.readBy !== deviceId) {
    chips.push({ text: 'Read on another device', colour: p.inkFaint });
  }

  if (chips.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.xs, marginTop: space.xs }}>
      {chips.map(chip => (
        <View
          key={chip.text}
          style={{
            paddingHorizontal: space.sm,
            paddingVertical: 2,
            borderRadius: radius.pill,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: chip.colour,
          }}
        >
          <Text variant="caption" style={{ color: chip.colour, fontSize: 11 }}>{chip.text}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The actions, revealed by tapping the row.
 *
 * Snooze is offered as real durations rather than a picker, because the choice
 * is always one of three and a picker would turn one tap into four. Which
 * actions appear depends on where the reminder sits: snoozing something that
 * has not fired yet would be meaningless, and there is nothing to mark read
 * about the future either.
 */
function Actions(props: RowProps) {
  const { entry } = props;
  const fired = entry.status === 'fired' || entry.status === 'snoozed';

  return (
    <View style={{ marginTop: space.md, gap: space.sm }}>
      {fired ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
          {props.snoozeOptions.slice(0, 3).map(minutes => (
            <Action
              key={minutes}
              label={snoozeLabel(minutes)}
              onPress={() => props.onSnooze([entry.key], minutes)}
            />
          ))}
          {entry.status === 'snoozed' ? (
            <Action label="Bring it back" onPress={() => props.onRead([entry.key])} />
          ) : null}
        </View>
      ) : (
        <Text variant="caption" tone="faint">
          Due {relativeLabel(entry.at, props.now)}. It will arrive with or without a connection.
        </Text>
      )}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {fired && !entry.completed && (entry.kind === 'task' || entry.kind === 'event') ? (
          <Action label="Mark done" tone="ok" onPress={() => props.onComplete([entry.key])} />
        ) : null}
        {fired ? (
          entry.read
            ? <Action label="Mark unread" onPress={() => props.onUnread([entry.key])} />
            : <Action label="Mark read" onPress={() => props.onRead([entry.key])} />
        ) : null}
        {props.onOpen ? (
          <Action label="Open the day" onPress={() => props.onOpen?.(entry)} />
        ) : null}
        <Action label="Remove" tone="danger" onPress={() => props.onClear([entry.key])} />
      </View>
    </View>
  );
}

function Action({
  label, onPress, tone = 'soft',
}: { label: string; onPress: () => void; tone?: 'soft' | 'ok' | 'danger' }) {
  const p = useTheme();
  const colour = { soft: p.inkSoft, ok: p.ok, danger: p.danger }[tone];
  return (
    <Pressable
      onPress={onPress}
      android_ripple={{ color: p.accentSoft }}
      style={{
        minHeight: 40,
        justifyContent: 'center',
        paddingHorizontal: space.md,
        borderRadius: radius.pill,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colour,
      }}
    >
      <Text variant="caption" style={{ color: colour, ...typeScale.caption }}>{label}</Text>
    </Pressable>
  );
}

/**
 * The one line under the title.
 *
 * It answers the question the screen exists for, in order of urgency: what is
 * waiting on you, then what is next, then the fact that nothing is.
 */
function headline(view: CentreView, now: number): string {
  if (view.unread > 0) {
    const critical = view.unreadCritical > 0 ? `, ${view.unreadCritical} critical` : '';
    return `${view.unread} waiting on you${critical}`;
  }
  if (view.nextAt != null) return `Next reminder ${relativeLabel(view.nextAt, now)}`;
  return 'Nothing waiting, nothing due';
}
