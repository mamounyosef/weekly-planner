/**
 * The tick box, and the half second after it is tapped.
 *
 * WHY THIS IS NOT JUST A BORDER AND A GLYPH
 * Ticking something off is the one thing this app is for, and it used to be the
 * flattest moment in it: the box swapped from an outline to a solid square the
 * instant a re-render happened to arrive, which read as lag whether or not
 * anything was actually slow. So the box now owns its own animation and runs it
 * the moment the finger lifts, ahead of the data, ahead of the list regrouping,
 * ahead of the row moving into Done.
 *
 * EVERYTHING HERE RUNS ON THE NATIVE DRIVER. Opacity and transform only: no
 * colour interpolation, no layout, nothing that has to cross back into JS for a
 * frame. The fill is a separate disc that scales in OVER the outline rather
 * than a background colour that animates, which is what keeps it that way.
 *
 * The screen still decides WHEN something is done. This only draws it, from
 * whatever `done` it is handed -- which is why the screens hand it their
 * optimistic answer (see `pendingDone` in `Tasks.tsx`) and not the stored one.
 */
import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';
import { PRESSED, PRESS_DELAY, space } from '../theme';
import { useTheme } from './kit';

export function Tick({
  done,
  colour,
  onPress,
  label,
  size = 22,
  round = true,
}: {
  done: boolean;
  colour: string;
  onPress: () => void;
  label?: string;
  size?: number;
  /** A circle for a task, a rounded square for an event. */
  round?: boolean;
}) {
  const p = useTheme();

  const fill = useRef(new Animated.Value(done ? 1 : 0)).current;
  const pop = useRef(new Animated.Value(0)).current;
  const halo = useRef(new Animated.Value(0)).current;
  // The first render is a state, not an event: a list of things already done
  // must not play twenty animations while it scrolls into view.
  const settled = useRef(done);

  useEffect(() => {
    if (settled.current === done) return;
    settled.current = done;

    Animated.spring(fill, {
      toValue: done ? 1 : 0,
      useNativeDriver: true,
      friction: 6,
      tension: 140,
    }).start();

    // A squash and a slight overshoot, so the box answers the finger itself
    // rather than waiting for anything else to change on the screen.
    pop.setValue(0);
    Animated.sequence([
      Animated.timing(pop, { toValue: 1, duration: 90, easing: Easing.out(Easing.quad), useNativeDriver: true }),
      Animated.spring(pop, { toValue: 0, useNativeDriver: true, friction: 4, tension: 180 }),
    ]).start();

    if (done) {
      halo.setValue(0);
      Animated.timing(halo, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    } else {
      halo.setValue(0);
    }
  }, [done, fill, pop, halo]);

  const radius = round ? size / 2 : Math.max(6, size * 0.28);

  return (
    <Pressable
      unstable_pressDelay={PRESS_DELAY}
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: done }}
      accessibilityLabel={label}
      hitSlop={space.md}
      style={({ pressed }) => [pressed ? PRESSED : null]}
    >
      <Animated.View
        style={{
          width: size,
          height: size,
          alignItems: 'center',
          justifyContent: 'center',
          transform: [{
            scale: pop.interpolate({ inputRange: [0, 1], outputRange: [1, 0.82] }),
          }],
        }}
      >
        {/* The ring that leaves. Drawn outside the box and behind everything,
            so it reads as a tap landing rather than as part of the control. */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: radius,
            borderWidth: 2,
            borderColor: colour,
            opacity: halo.interpolate({
              inputRange: [0, 0.12, 1],
              outputRange: [0, 0.4, 0],
            }),
            transform: [{
              scale: halo.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }),
            }],
          }}
        />

        {/* The outline, always there, always the same colour. */}
        <View
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: radius,
            borderWidth: 2,
            borderColor: p.inkFaint,
          }}
        />

        {/* The fill, which covers the outline entirely when it arrives. */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size,
            height: size,
            borderRadius: radius,
            backgroundColor: colour,
            opacity: fill,
            transform: [{
              scale: fill.interpolate({ inputRange: [0, 1], outputRange: [0.2, 1] }),
            }],
          }}
        />

        <Animated.Text
          style={{
            color: p.accentInk,
            fontSize: size * 0.6,
            lineHeight: size * 0.7,
            fontWeight: '900',
            opacity: fill,
            transform: [{
              scale: fill.interpolate({
                inputRange: [0, 0.7, 1],
                outputRange: [0.3, 1.2, 1],
              }),
            }],
          }}
        >
          ✓
        </Animated.Text>
      </Animated.View>
    </Pressable>
  );
}
