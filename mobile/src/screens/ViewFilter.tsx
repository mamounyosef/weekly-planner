import React, { useMemo } from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row, Spacer, Text, useTheme } from '../ui/kit';
import { PRESSED, PRESS_DELAY, radius, space } from '../theme';
import { usePlanner } from '../state/planner';
import { Tick } from '../ui/Tick';

export function ViewFilter({ onClose }: { onClose: () => void }) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const { categories, calendarView, hiddenCategoriesByView, setHiddenCategories, canUndo, canRedo, undoLabel, redoLabel, undo, redo } = usePlanner();

  const activeHidden = hiddenCategoriesByView[calendarView] || [];
  
  // Create a list of all categories + Uncategorised
  const list = useMemo(() => {
    const valid = (categories || []).filter((c: any) => c && typeof c === 'object' && typeof c.id === 'string');
    return [
      ...valid,
      { id: '__none__', name: 'Uncategorised', color: p.inkFaint }
    ];
  }, [categories, p.inkFaint]);

  const toggle = (id: string) => {
    const next = activeHidden.includes(id)
      ? activeHidden.filter((x: string) => x !== id)
      : [...activeHidden, id];
    setHiddenCategories(calendarView, next);
  };

  const setAll = (hidden: boolean) => {
    if (hidden) {
      setHiddenCategories(calendarView, list.map(c => c.id));
    } else {
      setHiddenCategories(calendarView, []);
    }
  };

  const allHidden = activeHidden.length === list.length;
  const noneHidden = activeHidden.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: p.bg }}>
      <View style={{
        paddingTop: insets.top + space.sm,
        paddingHorizontal: space.lg,
        paddingBottom: space.sm,
        borderBottomWidth: 1,
        borderBottomColor: p.line,
      }}>
        <Row gap={space.md} style={{ alignItems: 'center' }}>
          <Pressable
            unstable_pressDelay={PRESS_DELAY}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={space.sm}
            style={({ pressed }) => [{ paddingHorizontal: space.xs, paddingVertical: space.xs, justifyContent: 'center' }, pressed ? PRESSED : null]}
          >
            <Text variant="title" tone="accent">←</Text>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text variant="heading">Filters</Text>
            <Text variant="caption" tone="faint" style={{ marginTop: 2 }}>
              Choose what shows in the {calendarView} view.
            </Text>
          </View>
        </Row>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: insets.bottom + space.xxl,
          gap: space.md,
        }}
      >
        <Row style={{ justifyContent: 'space-between', paddingBottom: space.sm }}>
          <Pressable onPress={() => setAll(false)} hitSlop={space.sm}>
            <Text variant="caption" tone={noneHidden ? 'faint' : 'accent'}>Show all</Text>
          </Pressable>
          <Pressable onPress={() => setAll(true)} hitSlop={space.sm}>
            <Text variant="caption" tone={allHidden ? 'faint' : 'accent'}>Hide all</Text>
          </Pressable>
        </Row>

        {list.map((cat: any) => {
          const hidden = activeHidden.includes(cat.id);
          const colour = cat.color || p.inkFaint;
          return (
            <Pressable
              key={cat.id}
              unstable_pressDelay={PRESS_DELAY}
              onPress={() => toggle(cat.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: !hidden }}
              style={({ pressed }) => [{
                flexDirection: 'row',
                alignItems: 'center',
                paddingVertical: space.md,
                paddingHorizontal: space.md,
                backgroundColor: p.surface,
                borderRadius: radius.md,
                gap: space.md,
              }, pressed ? PRESSED : null]}
            >
              <Tick done={!hidden} colour={colour} onPress={() => toggle(cat.id)} round={false} />
              
              <View style={{
                width: 16, height: 16, borderRadius: 8, backgroundColor: colour,
              }} />
              
              <Text variant="body" style={{ flex: 1, opacity: hidden ? 0.5 : 1 }}>
                {cat.name || 'Untitled'}
              </Text>
            </Pressable>
          );
        })}
        {/* Undo / redo, at the tail of the sheet: reachable, but out of the
            way of the filter rows the thumb is already tapping. An undo here
            is a real synced edit, so it lands on the PC too. */}
        <Row gap={space.md} style={{ marginTop: space.sm }}>
          <Pressable
            unstable_pressDelay={PRESS_DELAY}
            onPress={() => { void undo(); }}
            disabled={!canUndo}
            accessibilityRole="button"
            accessibilityLabel={"Undo" + (undoLabel ? " " + undoLabel : "")}
            style={({ pressed }) => [{
              flex: 1,
              alignItems: "center",
              paddingVertical: space.md,
              backgroundColor: p.surface,
              borderRadius: radius.md,
              gap: space.xs,
              opacity: canUndo ? 1 : 0.35,
            }, pressed && canUndo ? PRESSED : null]}
          >
            <Text variant="body" tone={canUndo ? "accent" : "faint"}>↺  Undo</Text>
            {undoLabel ? (
              <Text variant="caption" tone="faint" numberOfLines={1}>{undoLabel}</Text>
            ) : null}
          </Pressable>
          <Pressable
            unstable_pressDelay={PRESS_DELAY}
            onPress={() => { void redo(); }}
            disabled={!canRedo}
            accessibilityRole="button"
            accessibilityLabel={"Redo" + (redoLabel ? " " + redoLabel : "")}
            style={({ pressed }) => [{
              flex: 1,
              alignItems: "center",
              paddingVertical: space.md,
              backgroundColor: p.surface,
              borderRadius: radius.md,
              gap: space.xs,
              opacity: canRedo ? 1 : 0.35,
            }, pressed && canRedo ? PRESSED : null]}
          >
            <Text variant="body" tone={canRedo ? "accent" : "faint"}>↻  Redo</Text>
            {redoLabel ? (
              <Text variant="caption" tone="faint" numberOfLines={1}>{redoLabel}</Text>
            ) : null}
          </Pressable>
        </Row>
        <Spacer size={space.lg} />
      </ScrollView>
    </View>
  );
}
