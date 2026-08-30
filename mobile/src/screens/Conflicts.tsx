// ─── Conflicts ───────────────────────────────────────────────────────────────
// The screen you only see when two devices genuinely disagreed.
//
// It shows both values side by side with WHERE and WHEN each came from, because
// that is what actually makes the choice obvious — not the values alone. One tap
// answers it, and the card goes away on both devices.
//
// What the app has already done for you is stated explicitly ("everything else
// merged automatically"), so a single card does not read as "your sync broke".

import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Divider, Empty, Row, Spacer, Text, useTheme } from '../ui/kit';
import { radius, space, HIT } from '../theme';
import { usePlanner } from '../state/planner';
import { describeAgo } from '../lib/syncClient';
import type { SyncConflict } from '../lib/sync';

export function Conflicts({ onClose }: { onClose: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { conflicts, answerConflict, status } = usePlanner();

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.md,
        paddingHorizontal: space.xl,
        paddingBottom: space.md,
      }}>
        <Row style={{ justifyContent: 'space-between' }}>
          <Text variant="title">
            {conflicts.length === 0
              ? 'Nothing to review'
              : conflicts.length === 1 ? '1 conflict' : `${conflicts.length} conflicts`}
          </Text>
          <Pressable
            onPress={onClose}
            accessibilityLabel="Close"
            style={{ width: HIT, height: HIT, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Text variant="title" tone="soft">✕</Text>
          </Pressable>
        </Row>
        <Text variant="caption" tone="faint">{status.label}</Text>
      </View>

      <Divider />

      <ScrollView contentContainerStyle={{
        padding: space.xl,
        paddingBottom: insets.bottom + space.xxl,
        gap: space.lg,
      }}>
        {conflicts.length === 0 ? (
          <Empty
            title="Everything agrees"
            hint="When your phone and PC change the same thing at the same time, the choice appears here. Everything else merges on its own."
          />
        ) : (
          <>
            <Text variant="caption" tone="soft">
              These are the only changes the app could not merge on its own. Everything else
              from both devices has already been kept.
            </Text>
            {conflicts.map(card => (
              <ConflictCard
                key={card.id}
                card={card}
                onChoose={choice => answerConflict(card, choice)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function ConflictCard({
  card,
  onChoose,
}: {
  card: SyncConflict;
  onChoose: (choice: 'winner' | 'loser' | 'delete' | 'keep') => void;
}) {
  const p = useTheme();
  const now = Date.now();
  const isDelete = card.kind === 'delete';

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <View style={{
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: p.warnSoft,
      }}>
        <Text variant="label" tone="warn">
          {isDelete ? 'Deleted here, edited there' : `Two versions of ${fieldLabel(card.field)}`}
        </Text>
      </View>

      <View style={{ padding: space.lg, gap: space.md }}>
        <Text variant="caption" tone="faint">
          {card.store === 'tasks' ? 'Task' : 'Event'} · edited on both devices while they were apart
        </Text>

        {isDelete ? (
          <Text variant="body">
            One device deleted this while the other was still changing it. The delete has
            been applied for now, so it is hidden on both devices — nothing is lost, and
            “Keep it” brings it back with your change.
          </Text>
        ) : (
          <Row gap={space.sm} align="stretch">
            <Side
              label={deviceLabel(card.winner.device)}
              when={describeAgo(now - card.winner.at)}
              value={card.winner.value}
              highlight
            />
            <Side
              label={deviceLabel(card.loser.device)}
              when={describeAgo(now - card.loser.at)}
              value={card.loser.value}
            />
          </Row>
        )}

        {isDelete ? (
          <Row gap={space.sm}>
            <Button label="Keep it" onPress={() => onChoose('keep')} style={{ flex: 1 }} />
            <Button label="Delete it" variant="danger" onPress={() => onChoose('delete')} style={{ flex: 1 }} />
          </Row>
        ) : (
          <>
            <Button
              label={`Keep ${deviceLabel(card.winner.device)}`}
              onPress={() => onChoose('winner')}
            />
            <Button
              label={`Keep ${deviceLabel(card.loser.device)}`}
              variant="secondary"
              onPress={() => onChoose('loser')}
            />
          </>
        )}

        <Text variant="caption" tone="faint">
          Whichever you pick is applied on both devices.
        </Text>
      </View>
    </Card>
  );
}

function Side({
  label, when, value, highlight,
}: {
  label: string; when: string; value: unknown; highlight?: boolean;
}) {
  const p = useTheme();
  return (
    <View style={{
      flex: 1,
      borderRadius: radius.sm,
      padding: space.md,
      backgroundColor: highlight ? p.accentSoft : p.surfaceAlt,
      gap: 4,
    }}>
      <Text variant="label" tone={highlight ? 'accent' : 'faint'}>{label}</Text>
      <Text variant="bodyStrong" numberOfLines={3}>{renderValue(value)}</Text>
      <Text variant="caption" tone="faint">{when}</Text>
    </View>
  );
}

/** Values are arbitrary JSON; show something a person can compare at a glance. */
function renderValue(value: unknown): string {
  if (value === undefined || value === null) return '(empty)';
  if (typeof value === 'string') return value.length === 0 ? '(empty)' : value;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.length === 0 ? '(none)' : value.join(', ');
  try {
    return JSON.stringify(value);
  } catch {
    return '(unreadable)';
  }
}

/** Field names are internal; the card must speak the user's language. */
function fieldLabel(field: string): string {
  const map: Record<string, string> = {
    title: 'the title',
    startTime: 'the start time',
    endTime: 'the end time',
    notes: 'the notes',
    categoryId: 'the category',
    weekKey: 'the date',
    dayIndex: 'the date',
    allDay: 'all-day',
    daysSpan: 'the length',
    color: 'the colour',
    notify: 'the reminder',
    completed: 'whether it is done',
    listId: 'the list',
    recur: 'how it repeats',
    locked: 'the repeat setting',
  };
  return map[field] ?? `"${field}"`;
}

function deviceLabel(device: string): string {
  if (device.startsWith('pc')) return 'PC';
  if (device.startsWith('android') || device.startsWith('phone')) return 'phone';
  if (device.startsWith('tablet')) return 'tablet';
  return device;
}
