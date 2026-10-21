// The voice orb on the phone: the same living ball of light as on the PC
// (VoiceOrbCanvas.tsx there), showing who is talking.
//
//   listening   calm blue, breathing          hearing    blue, rippling with you
//   thinking    violet, a comet circling      speaking   orange, pulsing, sparks
//   connecting  pale and shimmering           muted      grey     error  red
//
// React Native has no canvas here, so it is built from two white light shapes
// (assets/voice-soft.png, voice-disc.png; scripts/make-voice-orb.py), tinted
// and stacked: a halo, three overlapping discs stretched and turned a little
// differently every frame so the body wobbles like liquid, a hot core, and a
// drifting highlight. One animation loop reads the live loudness of the mic
// and the voice and moves everything with transforms only. Colours glide from
// one state to the next. Everything stays inside its square, so no edge ever
// shows.

import React, { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, View } from 'react-native';

import type { VoicePhase } from '../lib/voice/voiceTypes';

const SOFT = require('../../assets/voice-soft.png');
const DISC = require('../../assets/voice-disc.png');

type RGB = [number, number, number];
interface Palette { core: RGB; mid: RGB; edge: RGB; glow: RGB; accent: RGB }
const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

const PALETTES: Record<string, Palette> = {
  listening: { core: hex('#eaf4ff'), mid: hex('#60a5fa'), edge: hex('#1d4ed8'), glow: hex('#3b82f6'), accent: hex('#22d3ee') },
  hearing: { core: hex('#f0fbff'), mid: hex('#38bdf8'), edge: hex('#2563eb'), glow: hex('#0ea5e9'), accent: hex('#67e8f9') },
  thinking: { core: hex('#f5f3ff'), mid: hex('#a78bfa'), edge: hex('#4f46e5'), glow: hex('#7c3aed'), accent: hex('#e879f9') },
  speaking: { core: hex('#fff7ed'), mid: hex('#fb923c'), edge: hex('#ea580c'), glow: hex('#f97316'), accent: hex('#fbbf24') },
  connecting: { core: hex('#f1f5f9'), mid: hex('#94a3b8'), edge: hex('#475569'), glow: hex('#64748b'), accent: hex('#cbd5e1') },
  muted: { core: hex('#e5e7eb'), mid: hex('#6b7280'), edge: hex('#374151'), glow: hex('#4b5563'), accent: hex('#9ca3af') },
  error: { core: hex('#fef2f2'), mid: hex('#f87171'), edge: hex('#b91c1c'), glow: hex('#ef4444'), accent: hex('#fca5a5') },
};

function paletteFor(phase: VoicePhase, muted: boolean): Palette {
  if (phase === 'error') return PALETTES.error;
  if (muted && phase !== 'speaking' && phase !== 'thinking') return PALETTES.muted;
  if (phase === 'loading' || phase === 'connecting' || phase === 'ended') return PALETTES.connecting;
  return PALETTES[phase] ?? PALETTES.listening;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rgb = (c: RGB) => `rgb(${c[0] | 0},${c[1] | 0},${c[2] | 0})`;

const BLOBS: Array<{ waves: Array<[number, number, number]>; scale: number; drift: number; alpha: number }> = [
  { waves: [[2, 0.55, 0.0], [3, -0.8, 1.3]], scale: 1.0, drift: 0.12, alpha: 0.9 },
  { waves: [[3, 0.7, 0.7], [2, -1.0, 2.4]], scale: 0.93, drift: -0.18, alpha: 0.6 },
  { waves: [[2, -0.45, 1.9], [3, 0.9, 0.2]], scale: 0.86, drift: 0.22, alpha: 0.5 },
];
const COMET = 12;
const SPARKS = 10;
const RIPPLES = 3;

interface Layer { scale: Animated.Value; opacity: Animated.Value; tx: Animated.Value; ty: Animated.Value; rot: Animated.Value; sx: Animated.Value; sy: Animated.Value }
const layer = (): Layer => ({
  scale: new Animated.Value(0), opacity: new Animated.Value(0), tx: new Animated.Value(0), ty: new Animated.Value(0),
  rot: new Animated.Value(0), sx: new Animated.Value(1), sy: new Animated.Value(1),
});

export function VoiceOrb({ size, phase, muted = false, levels, onPress, label }: {
  size: number;
  phase: VoicePhase;
  muted?: boolean;
  levels: () => { mic: number; out: number };
  onPress?: () => void;
  label?: string;
}) {
  const live = useRef({ phase, muted, levels });
  live.current = { phase, muted, levels };
  const L = useRef<null | {
    halo: Layer; blobs: Layer[]; core: Layer; hi: Layer; ripples: Layer[]; comet: Layer[]; sparks: Layer[];
  }>(null);
  if (!L.current) {
    L.current = {
      halo: layer(), blobs: BLOBS.map(layer), core: layer(), hi: layer(),
      ripples: Array.from({ length: RIPPLES }, layer), comet: Array.from({ length: COMET }, layer), sparks: Array.from({ length: SPARKS }, layer),
    };
  }

  useEffect(() => {
    const ly = L.current!;
    const S = size;
    const c = S / 2;
    const edge = S * 0.47;
    let raf = 0;
    let last = Date.now();
    const t0 = last;
    const st = {
      pal: { ...paletteFor(live.current.phase, live.current.muted) } as Palette,
      energy: 0, slow: 0, spin: 0, think: 0, lastRipple: 0,
      ripples: [] as Array<{ born: number; strength: number }>,
      sparks: [] as Array<{ angle: number; radius: number; speed: number; size: number; life: number; born: number }>,
    };
    const frame = () => {
      const now = Date.now();
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      const { phase: ph, muted: mu, levels: lv } = live.current;
      const l = lv();
      const target = ph === 'speaking' ? l.out : ph === 'hearing' || ph === 'listening' ? l.mic : 0;
      st.energy = lerp(st.energy, target, target > st.energy ? 1 - Math.exp(-dt * 28) : 1 - Math.exp(-dt * 5));
      st.slow = lerp(st.slow, st.energy, 1 - Math.exp(-dt * 2.5));
      st.think = lerp(st.think, ph === 'thinking' || ph === 'loading' || ph === 'connecting' ? 1 : 0, 1 - Math.exp(-dt * 3));
      st.spin += dt * (0.25 + st.think * 2.2 + st.energy * 1.5);
      const tp = paletteFor(ph, mu);
      const pk = 1 - Math.exp(-dt * 4);
      const pal: Palette = st.pal = {
        core: mix(st.pal.core, tp.core, pk), mid: mix(st.pal.mid, tp.mid, pk), edge: mix(st.pal.edge, tp.edge, pk),
        glow: mix(st.pal.glow, tp.glow, pk), accent: mix(st.pal.accent, tp.accent, pk),
      };
      const e = st.energy;
      const breathe = Math.sin(t * (ph === 'listening' ? 1.4 : 2.2)) * 0.5 + 0.5;
      const R = S * 0.21 * (1 + e * 0.16 + breathe * 0.025 + st.think * 0.02);

      // Halo
      const haloR = Math.min(edge, R * (1.75 + e * 0.55 + breathe * 0.08));
      ly.halo.scale.setValue((2 * haloR) / S);
      ly.halo.opacity.setValue(0.55 + e * 0.35);

      // Ripples on loud moments
      if ((ph === 'hearing' || ph === 'speaking') && st.energy > 0.32 && st.energy > st.slow * 1.25 && now - st.lastRipple > 260) {
        st.ripples.push({ born: now, strength: Math.min(1, st.energy) });
        st.lastRipple = now;
      }
      st.ripples = st.ripples.filter(r => now - r.born < 1500).slice(-RIPPLES);
      ly.ripples.forEach((r, i) => {
        const rp = st.ripples[i];
        if (!rp) { r.opacity.setValue(0); return; }
        const a = (now - rp.born) / 1500;
        r.scale.setValue((2 * Math.min(edge * 0.92, R * (1.05 + a * 0.85))) / S);
        r.opacity.setValue((1 - a) * 0.5 * rp.strength);
      });

      // Body: three discs, each stretched and turned by its own slow waves.
      const wob = 0.04 + e * 0.2 + st.think * 0.03;
      BLOBS.forEach((b, bi) => {
        const bl = ly.blobs[bi];
        let d1 = 0;
        let d2 = 0;
        b.waves.forEach(([h, sp, p0], k) => {
          const v = Math.sin(t * sp * (1 + e * 2.5) + p0 + h);
          if (k === 0) d1 += v; else d2 += v;
        });
        bl.scale.setValue((2 * R * b.scale) / S);
        bl.sx.setValue(1 + wob * d1 * 0.5);
        bl.sy.setValue(1 - wob * d1 * 0.35 + wob * d2 * 0.3);
        bl.rot.setValue(st.spin * b.drift + bi * 1.1);
        bl.tx.setValue(Math.cos(t * 0.7 + bi * 2.1) * R * 0.05 * (1 + e));
        bl.ty.setValue(Math.sin(t * 0.9 + bi * 1.3) * R * 0.05 * (1 + e));
        bl.opacity.setValue(b.alpha);
      });

      // Core and highlight
      ly.core.scale.setValue((2 * R * (0.95 + e * 0.15)) / S);
      ly.core.opacity.setValue(0.9);
      ly.hi.scale.setValue((2 * R * 0.42) / S);
      ly.hi.tx.setValue(Math.cos(t * 0.6) * R * 0.28 - R * 0.12);
      ly.hi.ty.setValue(Math.sin(t * 0.45) * R * 0.22 - R * 0.2);
      ly.hi.opacity.setValue(0.55);

      // Thinking: a comet circling
      const orbit = R * 1.32;
      const head = st.spin * 1.6;
      ly.comet.forEach((d, i) => {
        const a = head - i * 0.11;
        d.tx.setValue(Math.cos(a) * orbit);
        d.ty.setValue(Math.sin(a) * orbit);
        d.scale.setValue(1 - i / (COMET + 3));
        d.opacity.setValue((1 - i / COMET) * st.think * 0.85);
      });

      // Speaking: sparks thrown off with the voice
      if (ph === 'speaking' && st.energy > 0.15 && Math.random() < st.energy * 0.6) {
        st.sparks.push({ angle: Math.random() * Math.PI * 2, radius: R * 0.95, speed: R * (0.5 + Math.random() * 0.9), size: 0.6 + Math.random() * 0.8, life: 0.9 + Math.random() * 0.6, born: now });
      }
      st.sparks = st.sparks.filter(s => (now - s.born) / 1000 < s.life).slice(-SPARKS);
      ly.sparks.forEach((d, i) => {
        const s = st.sparks[i];
        if (!s) { d.opacity.setValue(0); return; }
        const age = (now - s.born) / 1000;
        const f = age / s.life;
        const rr = s.radius + s.speed * age;
        const fade = Math.max(0, Math.min(1, (edge - rr) / (S * 0.1)));
        const a = s.angle + age * 0.6;
        d.tx.setValue(Math.cos(a) * rr);
        d.ty.setValue(Math.sin(a) * rr);
        d.scale.setValue(s.size * (1 - f * 0.6));
        d.opacity.setValue((1 - f) * 0.85 * fade);
      });

      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size]);


  // Colours glide from one state to the next: each layer's colour is a
  // crossfade between the last palette and the new one.
  const target = paletteFor(phase, muted);
  const [pair, setPair] = useState<{ from: Palette; to: Palette }>({ from: target, to: target });
  const fade = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (pair.to === target) return;
    setPair({ from: pair.to, to: target });
    fade.setValue(0);
    Animated.timing(fade, { toValue: 1, duration: 520, easing: Easing.inOut(Easing.ease), useNativeDriver: false }).start();
  }, [target, pair.to, fade]);
  const col = (pick: (p: Palette) => RGB) => fade.interpolate({ inputRange: [0, 1], outputRange: [rgb(pick(pair.from)), rgb(pick(pair.to))] });
  const C = {
    glow: col(p => p.glow),
    ripple: col(p => mix(p.accent, p.mid, 0.4)),
    blobs: [col(p => p.mid), col(p => mix(p.mid, p.accent, 0.55)), col(p => mix(p.edge, p.accent, 0.3))],
    core: col(p => p.core),
    accent: col(p => p.accent),
    spark: col(p => mix(p.accent, p.core, 0.3)),
  };

  const ly = L.current;
  const full = { position: 'absolute' as const, left: 0, top: 0, width: size, height: size };
  const img = (l: Layer, src: number, color: Animated.AnimatedInterpolation<string>) => (
    <Animated.Image
      source={src}
      style={[full, {
        tintColor: color as any,
        opacity: l.opacity,
        transform: [
          { translateX: l.tx }, { translateY: l.ty },
          { rotate: l.rot.interpolate({ inputRange: [0, 1], outputRange: ['0rad', '1rad'], extrapolate: 'extend' }) },
          { scale: l.scale }, { scaleX: l.sx }, { scaleY: l.sy },
        ],
      }]}
    />
  );
  const dot = (l: Layer, key: string, d: number, color: Animated.AnimatedInterpolation<string>) => (
    <Animated.View
      key={key}
      style={{
        position: 'absolute', left: size / 2 - d / 2, top: size / 2 - d / 2, width: d, height: d, borderRadius: d / 2,
        backgroundColor: color as any, opacity: l.opacity,
        transform: [{ translateX: l.tx }, { translateY: l.ty }, { scale: l.scale }],
      }}
    />
  );

  return (
    <Pressable onPress={onPress} accessibilityLabel={label} disabled={!onPress} style={{ width: size, height: size }}>
      <View style={{ width: size, height: size }} pointerEvents="none">
        {img(ly.halo, SOFT, C.glow)}
        {ly.ripples.map((r, i) => (
          <Animated.View
            key={`r${i}`}
            style={[full, { borderRadius: size / 2, borderWidth: Math.max(2, size * 0.012), borderColor: C.ripple as any, opacity: r.opacity, transform: [{ scale: r.scale }] }]}
          />
        ))}
        {ly.blobs.map((b, i) => <React.Fragment key={`b${i}`}>{img(b, DISC, C.blobs[i])}</React.Fragment>)}
        {img(ly.core, SOFT, C.core)}
        <Animated.Image
          source={SOFT}
          style={[full, { tintColor: '#ffffff', opacity: ly.hi.opacity, transform: [{ translateX: ly.hi.tx }, { translateY: ly.hi.ty }, { scale: ly.hi.scale }] }]}
        />
        {ly.comet.map((d, i) => dot(d, `c${i}`, Math.max(3, size * 0.03), i < 3 ? C.core : C.accent))}
        {ly.sparks.map((d, i) => dot(d, `s${i}`, Math.max(3, size * 0.022), C.spark))}
      </View>
    </Pressable>
  );
}
