// ─── Editor controls ─────────────────────────────────────────────────────────
// The pieces the item editor is built from, kept apart from the sheet itself so
// the sheet reads as a form rather than as three hundred lines of View.
//
// EVERY CONTROL HERE IS PURE JAVASCRIPT. Not one of them is a native picker, and
// that is a delivery decision rather than a stylistic one: a native module means
// this app can only reach the phone as a whole new APK, never over the air. A
// date wheel is not worth losing that.
//
// The other rule they share: a control says what it will do, and the label says
// what is true now. "Repeats every 2 weeks on Mon, Wed" is a sentence a person
// can check at a glance; "freq: weekly, interval: 2" is a data structure with a
// font.

import React from 'react';
import { Pressable, ScrollView, TextInput, View } from 'react-native';

import { Row, Text, useTheme } from './kit';
import { HIT, PRESSED, PRESS_DELAY, radius, space, type as typeScale } from '../theme';

// ─── Layout ──────────────────────────────────────────────────────────────────

export function Field({ label, hint, children }: {
  label: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <View style={{ gap: space.sm }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'baseline' }}>
        <Text variant="label" tone="faint" style={{ letterSpacing: 1 }}>
          {label.toUpperCase()}
        </Text>
        {hint ? <Text variant="caption" tone="faint">{hint}</Text> : null}
      </Row>
      {children}
    </View>
  );
}

export function TextField({ value, onChange, placeholder, autoFocus, multiline, invalid }: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  multiline?: boolean;
  invalid?: boolean;
}) {
  const p = useTheme();
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={p.inkFaint}
      autoFocus={autoFocus}
      multiline={multiline}
      style={{
        backgroundColor: p.surfaceAlt,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: invalid ? p.danger : p.line,
        color: p.ink,
        paddingHorizontal: space.md,
        paddingTop: multiline ? space.md : undefined,
        minHeight: multiline ? 88 : HIT,
        textAlignVertical: multiline ? 'top' : 'center',
        ...typeScale.body,
      }}
    />
  );
}

/** A row of mutually exclusive choices. */
export function Segment<T extends string>({ options, value, onChange }: {
  options: { key: T; label: string }[];
  value: T;
  onChange: (key: T) => void;
}) {
  const p = useTheme();
  return (
    <Row
      gap={0}
      style={{
        backgroundColor: p.surfaceAlt,
        borderRadius: radius.md,
        padding: 3,
        borderWidth: 1,
        borderColor: p.line,
      }}
    >
      {options.map(opt => {
        const on = opt.key === value;
        return (
          <Pressable
        unstable_pressDelay={PRESS_DELAY}
            key={opt.key}
            onPress={() => onChange(opt.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [{
              flex: 1, height: HIT - 8,
              alignItems: 'center', justifyContent: 'center',
              borderRadius: radius.sm,
              backgroundColor: on ? p.accent : 'transparent',
            }, pressed ? PRESSED : null]}
          >
            <Text variant="bodyStrong" style={{ color: on ? p.accentInk : p.inkSoft }}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

export function Toggle({ label, hint, value, onChange }: {
  label: string; hint?: string; value: boolean; onChange: (next: boolean) => void;
}) {
  const p = useTheme();
  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={() => onChange(!value)}
      accessibilityRole="switch"
      accessibilityState={{ checked: value }}
      style={({ pressed }) => [{
        flexDirection: 'row', alignItems: 'center', gap: space.md,
        paddingVertical: space.sm, minHeight: HIT,
      }, pressed ? PRESSED : null]}
    >
      <View style={{ flex: 1 }}>
        <Text variant="body">{label}</Text>
        {hint ? <Text variant="caption" tone="faint">{hint}</Text> : null}
      </View>
      <View style={{
        width: 46, height: 27, borderRadius: radius.pill, padding: 3,
        backgroundColor: value ? p.accent : p.surfaceAlt,
        borderWidth: 1, borderColor: value ? p.accent : p.line,
        alignItems: value ? 'flex-end' : 'flex-start',
      }}>
        <View style={{
          width: 19, height: 19, borderRadius: 10,
          backgroundColor: value ? p.accentInk : p.inkFaint,
        }} />
      </View>
    </Pressable>
  );
}

/** A number nudged rather than typed, for the small counts a form asks for. */
export function Stepper({ value, min, max, step = 1, onChange, format }: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (next: number) => void;
  format?: (n: number) => string;
}) {
  const p = useTheme();
  const clamp = (n: number) => Math.min(max, Math.max(min, n));

  const Btn = ({ label, to, disabled }: { label: string; to: number; disabled: boolean }) => (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={() => onChange(clamp(to))}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label === '+' ? 'More' : 'Fewer'}
      style={({ pressed }) => ({
        width: 44, height: 40,
        alignItems: 'center', justifyContent: 'center',
        borderRadius: radius.sm,
        backgroundColor: pressed ? p.accentSoft : 'transparent',
        opacity: disabled ? 0.35 : 1,
      })}
    >
      <Text variant="title" tone="soft">{label}</Text>
    </Pressable>
  );

  return (
    <Row style={{
      alignItems: 'center',
      alignSelf: 'flex-start',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: p.line,
      backgroundColor: p.surfaceAlt,
    }}>
      <Btn label="−" to={value - step} disabled={value <= min} />
      <View style={{ minWidth: 78, alignItems: 'center' }}>
        <Text variant="bodyStrong">{format ? format(value) : String(value)}</Text>
      </View>
      <Btn label="+" to={value + step} disabled={value >= max} />
    </Row>
  );
}

// ─── Colour and category ─────────────────────────────────────────────────────

export interface Swatch { key: string; hex: string }

/**
 * The colours, as colours.
 *
 * Named swatches rather than a colour wheel, because these are the same ten the
 * PC offers and an item should look the same on both. A free picker would let
 * the phone create colours the PC's own palette cannot name.
 */
export function ColourPicker({ value, onChange, swatches, disabled, disabledNote }: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
  swatches: Swatch[];
  disabled?: boolean;
  disabledNote?: string;
}) {
  const p = useTheme();

  if (disabled) {
    return <Text variant="caption" tone="faint">{disabledNote}</Text>;
  }

  return (
    <ScrollView
      horizontal
      // Android needs telling that this belongs to a bigger scroller. Without
      // it a vertical drag that happens to START on this strip is swallowed --
      // the sheet does not move, the strip does not move, and it reads as the
      // page being stuck rather than as a gesture landing on the wrong view.
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: space.sm, paddingRight: space.lg }}
    >
      {swatches.map(sw => {
        const on = value === sw.key || value === sw.hex;
        return (
          <Pressable
        unstable_pressDelay={PRESS_DELAY}
            key={sw.key}
            onPress={() => onChange(on ? undefined : sw.key)}
            accessibilityRole="button"
            accessibilityLabel={sw.key}
            accessibilityState={{ selected: on }}
            style={({ pressed }) => [{
              width: 38, height: 38, borderRadius: 19,
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: sw.hex,
              borderWidth: on ? 3 : 0,
              borderColor: p.ink,
            }, pressed ? PRESSED : null]}
          >
            {on ? (
              <Text style={{ color: '#fff', fontWeight: '900', fontSize: 15 }}>✓</Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function CategoryPicker({ value, onChange, categories }: {
  value: string | undefined;
  onChange: (id: string | undefined) => void;
  categories: { id: string; name: string; color: string }[];
}) {
  const p = useTheme();

  const Chip = ({ id, name, colour }: { id?: string; name: string; colour?: string }) => {
    const on = value === id || (!value && !id);
    return (
      <Pressable
        unstable_pressDelay={PRESS_DELAY}
        onPress={() => onChange(id)}
        accessibilityRole="button"
        accessibilityState={{ selected: on }}
        style={({ pressed }) => [{
          flexDirection: 'row', alignItems: 'center', gap: space.sm,
          paddingHorizontal: space.md, height: 38,
          borderRadius: radius.pill,
          backgroundColor: on ? p.accentSoft : p.surfaceAlt,
          borderWidth: 1,
          borderColor: on ? p.accent : p.line,
        }, pressed ? PRESSED : null]}
      >
        {colour ? (
          <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: colour }} />
        ) : null}
        <Text variant="body" tone={on ? 'accent' : 'soft'}>{name}</Text>
      </Pressable>
    );
  };

  return (
    <ScrollView
      horizontal
      // Android needs telling that this belongs to a bigger scroller. Without
      // it a vertical drag that happens to START on this strip is swallowed --
      // the sheet does not move, the strip does not move, and it reads as the
      // page being stuck rather than as a gesture landing on the wrong view.
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{ gap: space.sm, paddingRight: space.lg }}
    >
      <Chip name="None" />
      {categories.map(c => <Chip key={c.id} id={c.id} name={c.name} colour={c.color} />)}
    </ScrollView>
  );
}
