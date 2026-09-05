// ─── Conflicts ───────────────────────────────────────────────────────────────
// The screen you only see when two devices genuinely disagreed.
//
// WHY WE GROUP BY ITEM: A raw conflict exists per field. If you edit a title,
// time, and category offline, and the PC edits them too, the engine raises
// three conflicts. Presenting them as three separate cards is exhausting and
// loses context. Grouping them by item lets you see the whole disagreement and
// optionally resolve all fields with a single tap.
//
// What the app has already done for you is stated explicitly ("everything else
// merged automatically"), so a single card does not read as "your sync broke".

import React, { useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Card, Divider, Empty, Row, Text, useTheme } from '../ui/kit';
import { HIT, PRESSED, PRESS_DELAY, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import type { SyncConflict } from '../lib/sync';
import { groupConflicts, type GroupedConflict } from '../lib/conflictText';

export function Conflicts({ onClose }: { onClose: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { conflicts, answerConflict, status, peek } = usePlanner();

  const now = Date.now();
  
  /**
   * Recomputed whenever the conflicts change.
   *
   * `peek` rather than `events()`/`tasks()`: it reaches every store, not two of
   * eight, and it reads THROUGH a tombstone. Both of those were why almost
   * every card said "Untitled item" -- a focus session was a store the lookup
   * did not know, and a deleted event was a record the lookup refused to
   * return.
   */
  const groups = useMemo(
    () => groupConflicts(conflicts, now, peek),
    [conflicts, now, peek],
  );

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
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
        unstable_pressDelay={PRESS_DELAY}
            onPress={onClose}
            accessibilityLabel="Close"
            style={({ pressed }) => [{ width: HIT, height: HIT, alignItems: 'flex-end', justifyContent: 'center' }, pressed ? PRESSED : null]}
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
        {groups.length === 0 ? (
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
            {groups.map(group => (
              <GroupCard
                key={`${group.store}:${group.entityId}`}
                group={group}
                onAnswer={(conflict, choice) => answerConflict(conflict, choice)}
              />
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}

function GroupCard({
  group,
  onAnswer,
}: {
  group: GroupedConflict;
  onAnswer: (conflict: SyncConflict, choice: 'winner' | 'loser' | 'delete' | 'keep') => void;
}) {
  const p = useTheme();

  // Resolve all non-delete fields at once with a single choice.
  // Deletes are excluded because their choices ('keep' / 'delete') are incompatible
  // with field choices ('winner' / 'loser'), and a delete naturally overrides
  // field edits anyway.
  const handleKeepAll = (choice: 'winner' | 'loser') => {
    group.conflicts.forEach(c => {
      if (!c.isDelete) {
        onAnswer(c.raw, choice as any);
      }
    });
  };

  const hasFieldConflicts = group.conflicts.some(c => !c.isDelete);
  
  // Find the common device labels to make the "Keep for all" buttons read naturally.
  const winnerLabels = new Set(group.conflicts.filter(c => !c.isDelete).map(c => c.winnerLabel));
  const loserLabels = new Set(group.conflicts.filter(c => !c.isDelete).map(c => c.loserLabel));
  const commonWinner = winnerLabels.size === 1 ? Array.from(winnerLabels)[0] : 'winner';
  const commonLoser = loserLabels.size === 1 ? Array.from(loserLabels)[0] : 'loser';

  return (
    <Card style={{ padding: 0, overflow: 'hidden' }}>
      <View style={{
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: p.surfaceAlt,
      }}>
        <Text variant="label" tone="ink">{group.itemTitle}</Text>
        {/* WHAT IT IS, and whether it still exists. This line used to call
            everything that was not a task an event, so a focus session was
            announced as one. */}
        <Text variant="caption" tone="faint">{group.subtitle}</Text>
      </View>

      <View style={{ padding: space.lg, gap: space.xl }}>
        {group.conflicts.map(c => (
          <View key={c.fieldFriendlyName} style={{ gap: space.md }}>
            <Text variant="label" tone="warn">
              {c.isDelete ? 'Deleted on one device' : `Two answers for ${c.fieldFriendlyName}`}
            </Text>
            
            {c.isDelete ? (
              <Text variant="body">
                Deleted on one device, changed on the other. It is hidden for now,
                and nothing is lost either way.
              </Text>
            ) : (
              <Row gap={space.sm} align="stretch">
                <Side
                  label={c.winnerLabel}
                  when={c.winnerTime}
                  value={c.winnerValue}
                  highlight
                />
                <Side
                  label={c.loserLabel}
                  when={c.loserTime}
                  value={c.loserValue}
                />
              </Row>
            )}

            {c.isDelete ? (
              <Row gap={space.sm}>
                <Button label="Keep it" onPress={() => onAnswer(c.raw, 'keep')} style={{ flex: 1 }} />
                <Button label="Delete it" variant="danger" onPress={() => onAnswer(c.raw, 'delete')} style={{ flex: 1 }} />
              </Row>
            ) : (
              <View style={{ gap: space.sm }}>
                <Button
                  label={c.choices[0].label}
                  onPress={() => onAnswer(c.raw, c.choices[0].value as any)}
                />
                <Button
                  label={c.choices[1].label}
                  variant="secondary"
                  onPress={() => onAnswer(c.raw, c.choices[1].value as any)}
                />
              </View>
            )}
          </View>
        ))}

        {hasFieldConflicts && group.conflicts.length > 1 && (
          <View style={{ marginTop: space.sm, paddingTop: space.md, borderTopWidth: 1, borderColor: p.line }}>
            <Text variant="caption" tone="faint" style={{ marginBottom: space.md }}>
              Resolve all {group.conflicts.filter(c => !c.isDelete).length} fields at once:
            </Text>
            <Row gap={space.sm}>
              <Button 
                label={`Keep ${commonWinner} for all`} 
                onPress={() => handleKeepAll('winner')} 
                style={{ flex: 1 }} 
              />
              <Button 
                label={`Keep ${commonLoser} for all`} 
                variant="secondary" 
                onPress={() => handleKeepAll('loser')} 
                style={{ flex: 1 }} 
              />
            </Row>
          </View>
        )}
      </View>
    </Card>
  );
}

function Side({
  label, when, value, highlight,
}: {
  label: string; when: string; value: string; highlight?: boolean;
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
      <Text variant="bodyStrong" numberOfLines={3}>{value}</Text>
      <Text variant="caption" tone="faint">{when}</Text>
    </View>
  );
}
