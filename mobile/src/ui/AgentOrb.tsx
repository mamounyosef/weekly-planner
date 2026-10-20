// The assistant's mark on the phone: the same glowing orb the PC draws (and
// the Notes app's assistant wears), rendered from the same gradient stops by
// scripts/make-orb.py.
//
// It is alive rather than a picture: the core breathes, a soft highlight
// drifts around inside it, and the glow behind it swells and settles. While
// working everything quickens and rings ripple outwards. All on the native
// driver, so it costs the JS thread nothing.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';

const ORB = require('../../assets/agent-orb.png');
const GLOW = require('../../assets/agent-orb-glow.png');
const SPARK = require('../../assets/agent-orb-spark.png');

function loop(v: Animated.Value, to: number, duration: number) {
  return Animated.loop(Animated.sequence([
    Animated.timing(v, { toValue: to, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    Animated.timing(v, { toValue: 0, duration, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
  ]));
}

export function AgentOrb({ size = 24, busy = false, still = false, dim = false, tile }: {
  size?: number;
  busy?: boolean;
  /** Calm motion only (tab bar, small places): a slow glow and drift, no breathing. */
  still?: boolean;
  /** Muted, for an unselected tab. */
  dim?: boolean;
  /** Sit on a rounded tile, as in the Notes app's header and empty state. */
  tile?: { bg: string; border: string; radius?: number; pad?: number; glow?: boolean };
}) {
  const breath = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const ripple = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const anims: Animated.CompositeAnimation[] = [];
    const period = busy ? 575 : still ? 3000 : 2100;
    anims.push(loop(breath, 1, period));
    spin.setValue(0);
    anims.push(Animated.loop(Animated.timing(spin, {
      toValue: 1, duration: busy ? 1600 : still ? 14000 : 9000, easing: Easing.linear, useNativeDriver: true,
    })));
    if (busy) {
      ripple.setValue(0);
      anims.push(Animated.loop(Animated.timing(ripple, {
        toValue: 1, duration: 1400, easing: Easing.out(Easing.cubic), useNativeDriver: true,
      })));
    }
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, [busy, still, breath, spin, ripple]);

  const coreScale = still && !busy ? 1 : breath.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1.04] });
  const glowScale = breath.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1.12] });
  const glowOpacity = breath.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.85] });
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const rippleScale = ripple.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.65] });
  const rippleOpacity = ripple.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0] });
  const halo = size * 1.44;

  const orb = (
    <View style={{ width: size, height: size, opacity: dim ? 0.55 : 1 }}>
      <Animated.Image
        source={GLOW}
        style={{
          position: 'absolute', width: halo, height: halo, left: (size - halo) / 2, top: (size - halo) / 2,
          opacity: glowOpacity, transform: [{ scale: glowScale }],
        }}
      />
      {busy ? (
        <Animated.View
          style={{
            position: 'absolute', width: size, height: size, borderRadius: size / 2,
            borderWidth: 1.5, borderColor: 'rgba(124,156,255,0.7)',
            opacity: rippleOpacity, transform: [{ scale: rippleScale }],
          }}
        />
      ) : null}
      <Animated.Image source={ORB} style={{ width: size, height: size, transform: [{ scale: coreScale }] }} />
      <Animated.View
        style={{
          position: 'absolute', left: size * 0.08, top: size * 0.08, width: size * 0.84, height: size * 0.84,
          transform: [{ rotate }],
        }}
      >
        <Animated.Image
          source={SPARK}
          style={{ position: 'absolute', left: size * 0.84 * 0.18, top: size * 0.84 * 0.14, width: size * 0.84 * 0.34, height: size * 0.84 * 0.34 }}
        />
      </Animated.View>
    </View>
  );

  if (!tile) return orb;
  const pad = tile.pad ?? Math.round(size * 0.3);
  const box = size + pad * 2;
  return (
    <View
      style={{
        width: box, height: box, borderRadius: tile.radius ?? Math.round(box * 0.3),
        backgroundColor: tile.bg, borderWidth: 1, borderColor: tile.border,
        alignItems: 'center', justifyContent: 'center',
        ...(tile.glow ? { shadowColor: '#7c9cff', shadowOpacity: 0.35, shadowRadius: 20, shadowOffset: { width: 0, height: 8 }, elevation: 8 } : {}),
      }}
    >
      {orb}
    </View>
  );
}
