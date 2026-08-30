// ─── The task lists, as a strip ──────────────────────────────────────────────
// One component for two jobs: the strip that filters the Tasks screen, and the
// picker that files a task on a list from the editor.
//
// It is shared rather than written twice because the two have to READ as the
// same idea. If the chip you tap to see "University" is a different shape or a
// different colour from the chip you tap to file something there, a person has
// to learn the lists twice.
//
// Pure JavaScript, like every other control in this app: a native segmented
// control would cost the over-the-air update path, which is worth more than a
// platform-shaped chip.

import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';

import { Text, useTheme } from './kit';
import { radius, space } from '../theme';

export interface ListChoice {
  id: string;
  name: string;
  color?: string;
}

export function ListChips({ options, value, onChange, allLabel, inset = 0 }: {
  options: ListChoice[];
  /** null selects the leading "all" chip, when one is offered. */
  value: string | null;
  onChange: (next: string | null) => void;
  /** Offer a leading chip that selects nothing. Absent means every chip files. */
  allLabel?: string;
  /** Side padding, so the strip can bleed to the screen edge while its first
   *  chip still lines up with the text above it. */
  inset?: number;
}) {
  const p = useTheme();

  const Chip = ({ id, name, colour }: { id: string | null; name: string; colour?: string }) => {
    const on = value === id;
    return (
      <Pressable
        onPress={() => onChange(id)}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        android_ripple={{ color: p.accentSoft }}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.md,
          height: 36,
          borderRadius: radius.pill,
          backgroundColor: on ? p.accentSoft : p.surfaceAlt,
          borderWidth: 1,
          borderColor: on ? p.accent : p.line,
        }}
      >
        {colour ? (
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colour }} />
        ) : null}
        <Text variant="body" tone={on ? 'accent' : 'soft'}>{name}</Text>
      </Pressable>
    );
  };

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        gap: space.sm,
        paddingLeft: inset,
        paddingRight: inset,
      }}
    >
      {allLabel ? <Chip id={null} name={allLabel} /> : null}
      {options.map(o => <Chip key={o.id} id={o.id} name={o.name} colour={o.color} />)}
    </ScrollView>
  );
}
