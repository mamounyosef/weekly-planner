// ─── UI primitives ───────────────────────────────────────────────────────────
// Small, unopinionated pieces that every screen shares, so spacing and type stay
// consistent without each screen re-deciding them.

import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  Text as RNText,
  StyleSheet,
  View,
  useColorScheme,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { HIT, MAX_FONT_SCALE, PRESS_DELAY, TAP_DELAY, dark, radius, resolvePalette, space, type Palette, type ThemeMode, type as typeScale } from '../theme';
import { prefs } from '../lib/prefs';

const ThemeContext = createContext<Palette>(dark);

interface ThemeModeValue {
  mode: ThemeMode;
  setMode(next: ThemeMode): void;
}

const ThemeModeContext = createContext<ThemeModeValue>({ mode: 'system', setMode: () => {} });

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const scheme = useColorScheme();
  const [mode, setModeState] = useState<ThemeMode>('system');

  // Read once at launch rather than gating the first render on it: this provider
  // wraps the splash, and a keystore that is slow to answer must never be able to
  // hold the whole app on a blank screen. The worst case is one frame of the
  // system theme before the saved choice lands.
  useEffect(() => {
    let cancelled = false;
    void prefs.getThemeMode().then(saved => {
      if (!cancelled) setModeState(saved);
    });
    return () => { cancelled = true; };
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    // Paint first, persist after. Nothing downstream depends on the write, and
    // a tap on a theme button should never feel like it is waiting on storage.
    setModeState(next);
    void prefs.setThemeMode(next);
  }, []);

  // The planner is checked last thing at night as often as first thing in the
  // morning, so both themes are real designs rather than one plus an inversion.
  //
  // Memoised because this object IS the context value: rebuilding it hands a
  // new identity to every `useTheme()` in the app, which is very nearly every
  // component there is.
  const palette = useMemo(() => resolvePalette(mode, scheme), [mode, scheme]);
  const modeValue = useMemo(() => ({ mode, setMode }), [mode, setMode]);

  return (
    <ThemeModeContext.Provider value={modeValue}>
      <ThemeContext.Provider value={palette}>{children}</ThemeContext.Provider>
    </ThemeModeContext.Provider>
  );
}

export const useTheme = (): Palette => useContext(ThemeContext);

/** The appearance choice itself, for the one screen that lets you change it. */
export const useThemeMode = (): ThemeModeValue => useContext(ThemeModeContext);

type TextVariant = keyof typeof typeScale;

export function Text({
  variant = 'body',
  tone = 'ink',
  style,
  children,
  numberOfLines,
  maxFontSizeMultiplier,
}: {
  variant?: TextVariant;
  tone?: 'ink' | 'soft' | 'faint' | 'accent' | 'ok' | 'warn' | 'danger' | 'onAccent';
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
  /** Overrides the variant's cap. `0` opts out of capping entirely. */
  maxFontSizeMultiplier?: number;
}) {
  const p = useTheme();
  const colour = {
    ink: p.ink, soft: p.inkSoft, faint: p.inkFaint, accent: p.accent,
    ok: p.ok, warn: p.warn, danger: p.danger, onAccent: p.accentInk,
  }[tone];

  // Capped by variant unless the caller says otherwise. `0` is React Native's
  // own way of saying "do not cap", and is passed through untouched so a screen
  // whose whole purpose is large type can still opt out.
  const cap = maxFontSizeMultiplier ?? MAX_FONT_SCALE[variant];

  return (
    <RNText
      numberOfLines={numberOfLines}
      maxFontSizeMultiplier={cap === 0 ? undefined : cap}
      style={[
        typeScale[variant],
        { color: colour },
        variant === 'label' && { textTransform: 'uppercase' },
        style,
      ]}
    >
      {children}
    </RNText>
  );
}

export function Card({
  children,
  style,
  onPress,
  accent,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  /** A colour stripe down the left edge — the item's own category colour. */
  accent?: string;
}) {
  const p = useTheme();
  const body = (
    <View
      style={[
        {
          backgroundColor: p.surface,
          borderRadius: radius.md,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: p.line,
          padding: space.lg,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      {accent ? (
        <View style={{
          position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: accent,
        }} />
      ) : null}
      {children}
    </View>
  );

  if (!onPress) return body;
  return (
    <Pressable
        unstable_pressDelay={PRESS_DELAY}
      onPress={onPress}
      android_ripple={{ color: p.accentSoft }}
      style={({ pressed }) => [pressed && { opacity: 0.85, transform: [{ scale: 0.995 }] }]}
    >
      {body}
    </Pressable>
  );
}

export function Button({
  label,
  onPress,
  variant = 'primary',
  busy,
  disabled,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const p = useTheme();
  const off = disabled || busy;

  const bg = {
    primary: p.accent,
    secondary: p.surfaceAlt,
    quiet: 'transparent',
    danger: 'transparent',
  }[variant];
  const fg = {
    primary: p.accentInk,
    secondary: p.ink,
    quiet: p.inkSoft,
    danger: p.danger,
  }[variant];

  return (
    <Pressable
      /* NO DELAY. A `Button` is a committed action -- Save, Cancel, Delete,
         Sign in -- always laid out as a full-width control and never as a row
         you might be about to scroll past. `theme.ts` names this case exactly:
         with nothing to disambiguate from, the hundred milliseconds are pure
         latency, and they were being paid on the primary action of nearly
         every sheet in the app. */
      unstable_pressDelay={TAP_DELAY}
      onPress={onPress}
      disabled={off}
      android_ripple={{ color: variant === 'primary' ? 'rgba(0,0,0,0.15)' : p.accentSoft }}
      style={({ pressed }) => [
        {
          minHeight: HIT,
          paddingHorizontal: space.xl,
          borderRadius: radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          gap: space.sm,
          backgroundColor: bg,
          borderWidth: variant === 'danger' ? StyleSheet.hairlineWidth : 0,
          borderColor: p.danger,
          opacity: off ? 0.5 : pressed ? 0.9 : 1,
        },
        style,
      ]}
    >
      {busy ? <ActivityIndicator size="small" color={fg} /> : null}
      <RNText style={[typeScale.bodyStrong, { color: fg }]}>{label}</RNText>
    </Pressable>
  );
}

/** A small status chip. `tone` carries the meaning; the shape never changes. */
export function Pill({
  label,
  tone = 'neutral',
}: {
  label: string;
  tone?: 'neutral' | 'ok' | 'warn' | 'accent';
}) {
  const p = useTheme();
  const map = {
    neutral: { bg: p.surfaceAlt, fg: p.inkSoft },
    ok: { bg: 'transparent', fg: p.ok },
    warn: { bg: p.warnSoft, fg: p.warn },
    accent: { bg: p.accentSoft, fg: p.accent },
  }[tone];

  return (
    <View style={{
      backgroundColor: map.bg,
      paddingHorizontal: space.md,
      paddingVertical: 5,
      borderRadius: radius.pill,
      alignSelf: 'flex-start',
    }}>
      <RNText style={[typeScale.caption, { color: map.fg, fontWeight: '600' }]}>{label}</RNText>
    </View>
  );
}

/** A live dot for the sync state — colour and motion both carry meaning. */
export function StatusDot({ tone }: { tone: 'ok' | 'warn' | 'offline' | 'busy' }) {
  const p = useTheme();
  const colour = { ok: p.ok, warn: p.warn, offline: p.inkFaint, busy: p.accent }[tone];
  return (
    <View style={{
      width: 8, height: 8, borderRadius: 4, backgroundColor: colour,
      opacity: tone === 'busy' ? 0.6 : 1,
    }} />
  );
}

export function Divider() {
  const p = useTheme();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: p.line }} />;
}

/** An empty state that says what to do, never just "nothing here". */
export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <View style={{ alignItems: 'center', paddingVertical: space.xxl * 1.5, gap: space.sm }}>
      <Text variant="heading" tone="soft">{title}</Text>
      {hint ? (
        <Text variant="caption" tone="faint" style={{ textAlign: 'center', maxWidth: 260 }}>
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

export function Row({
  children,
  gap = space.md,
  align = 'center',
  style,
}: {
  children: React.ReactNode;
  gap?: number;
  align?: ViewStyle['alignItems'];
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ flexDirection: 'row', alignItems: align, gap }, style]}>{children}</View>
  );
}

export function Spacer({ size = space.lg }: { size?: number }) {
  return <View style={{ height: size }} />;
}
