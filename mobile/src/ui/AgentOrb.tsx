// The assistant's mark on the phone: the exact sky-blue orb the PC draws,
// rendered once to assets/agent-orb.png (from the same gradient stops) so
// both look identical. It breathes while idle and pulses while working.

import React, { useEffect, useRef } from 'react';
import { Animated, Easing } from 'react-native';

const ORB = require('../../assets/agent-orb.png');

export function AgentOrb({ size = 24, busy = false, still = false, dim = false }: {
  size?: number;
  busy?: boolean;
  /** No breathing (tab bar, small places). */
  still?: boolean;
  /** Muted, for an unselected tab. */
  dim?: boolean;
}) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (still && !busy) { scale.setValue(1); return; }
    const dur = busy ? 520 : 2200;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(scale, { toValue: busy ? 1.1 : 1.045, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(scale, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [busy, still, scale]);

  return (
    <Animated.Image
      source={ORB}
      style={{ width: size, height: size, borderRadius: size / 2, transform: [{ scale }], opacity: dim ? 0.55 : 1 }}
    />
  );
}
