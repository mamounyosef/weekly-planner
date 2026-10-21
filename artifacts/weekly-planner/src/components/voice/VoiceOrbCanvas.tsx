// The voice orb: a living ball of light that shows who is talking.
//
//   listening   calm blue, slowly breathing, waiting for you
//   hearing     blue and cyan, its surface rippling with your voice
//   thinking    indigo and violet, swirling, a comet circling it
//   speaking    orange and amber, pulsing with the assistant's voice
//   connecting  pale and shimmering while the speech engine wakes up
//   muted       grey, still
//   error       red
//
// Drawn on a canvas every frame from the live loudness of the mic and the
// voice, so it moves with the actual sound rather than playing a loop. The
// colours glide from one state to the next instead of snapping. Three
// translucent blobs, each warped by its own set of slow waves, are added
// together for the body; ripples spread out on loud moments; sparks orbit
// while it speaks. Stops drawing whenever it cannot be seen.

import React, { useEffect, useRef } from 'react';

import type { VoicePhase } from '@/lib/voice/voiceSession';

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
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;

/** Each blob's own waves: [harmonic, speed, phase]. Prime-ish harmonics never line up. */
const BLOBS: Array<{ waves: Array<[number, number, number]>; scale: number; drift: number; alpha: number }> = [
  { waves: [[2, 0.55, 0.0], [3, -0.8, 1.3], [5, 1.15, 2.1]], scale: 1.0, drift: 0.12, alpha: 0.95 },
  { waves: [[3, 0.7, 0.7], [4, -1.0, 2.4], [7, 1.4, 0.4]], scale: 0.93, drift: -0.18, alpha: 0.65 },
  { waves: [[2, -0.45, 1.9], [5, 0.9, 0.2], [6, -1.3, 1.1]], scale: 0.86, drift: 0.22, alpha: 0.55 },
];

interface Ripple { born: number; strength: number }
interface Spark { angle: number; radius: number; speed: number; size: number; life: number; born: number }

export default function VoiceOrbCanvas({ size, phase, muted = false, levels, onClick, title, className, style }: {
  /** CSS pixels, square. The glow is drawn inside this box. */
  size: number;
  phase: VoicePhase;
  muted?: boolean;
  /** Called every frame: 0..1 loudness of the mic and of the voice. */
  levels: () => { mic: number; out: number };
  onClick?: () => void;
  title?: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const live = useRef({ phase, muted, levels });
  live.current = { phase, muted, levels };

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    let raf = 0;
    let visible = true;
    let last = performance.now();
    const t0 = last;
    const st = {
      pal: paletteFor(live.current.phase, live.current.muted),
      energy: 0,
      slow: 0,
      spin: 0,
      think: 0,
      ripples: [] as Ripple[],
      sparks: [] as Spark[],
      lastRipple: 0,
      peak: 0,
    };

    const draw = (now: number) => {
      raf = 0;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = (now - t0) / 1000;
      const { phase: ph, muted: mu, levels: lv } = live.current;
      const dpr = Math.min(2.5, window.devicePixelRatio || 1);
      const px = Math.round(size * dpr);
      if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);

      // ── Inputs, smoothed: quick to rise, slow to fall ──
      const l = lv();
      const target = ph === 'speaking' ? l.out : ph === 'hearing' || ph === 'listening' ? l.mic : 0;
      const k = target > st.energy ? 1 - Math.exp(-dt * 28) : 1 - Math.exp(-dt * 5);
      st.energy = lerp(st.energy, target, k);
      st.slow = lerp(st.slow, st.energy, 1 - Math.exp(-dt * 2.5));
      st.think = lerp(st.think, ph === 'thinking' || ph === 'loading' || ph === 'connecting' ? 1 : 0, 1 - Math.exp(-dt * 3));
      st.spin += dt * (0.25 + st.think * 2.2 + st.energy * 1.5);
      const target_pal = paletteFor(ph, mu);
      const pk = 1 - Math.exp(-dt * 4);
      st.pal = {
        core: mix(st.pal.core, target_pal.core, pk), mid: mix(st.pal.mid, target_pal.mid, pk),
        edge: mix(st.pal.edge, target_pal.edge, pk), glow: mix(st.pal.glow, target_pal.glow, pk),
        accent: mix(st.pal.accent, target_pal.accent, pk),
      };
      const pal = st.pal;
      const e = reduce ? 0 : st.energy;
      const c = size / 2;
      const breathe = reduce ? 0 : Math.sin(t * (ph === 'listening' ? 1.4 : 2.2)) * 0.5 + 0.5;
      // Everything fades out inside the canvas: a glow cut off at its edge
      // shows the canvas as a box.
      const R = size * 0.21 * (1 + e * 0.16 + breathe * 0.025 + st.think * 0.02);
      const edge = size * 0.48;

      // ── Ripples on loud moments ──
      if (!reduce && (ph === 'hearing' || ph === 'speaking')) {
        st.peak = Math.max(st.peak * Math.exp(-dt * 3), st.energy);
        if (st.energy > 0.32 && st.energy > st.slow * 1.25 && now - st.lastRipple > 260) {
          st.ripples.push({ born: now, strength: Math.min(1, st.energy) });
          st.lastRipple = now;
        }
      }
      st.ripples = st.ripples.filter(r => now - r.born < 1500);

      // ── Halo ──
      const haloR = Math.min(edge, R * (1.75 + e * 0.55 + breathe * 0.08));
      let g = ctx.createRadialGradient(c, c, R * 0.4, c, c, haloR);
      g.addColorStop(0, rgba(pal.glow, 0.42 + e * 0.25));
      g.addColorStop(0.45, rgba(pal.glow, 0.16 + e * 0.12));
      g.addColorStop(1, rgba(pal.glow, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, haloR, 0, Math.PI * 2);
      ctx.fill();

      // ── Ripples ──
      for (const r of st.ripples) {
        const a = (now - r.born) / 1500;
        const rr = Math.min(edge * 0.92, R * (1.05 + a * 0.85));
        ctx.strokeStyle = rgba(mix(pal.accent, pal.mid, 0.4), (1 - a) * 0.45 * r.strength);
        ctx.lineWidth = Math.max(0.6, size * 0.012 * (1 - a));
        ctx.beginPath();
        ctx.arc(c, c, rr, 0, Math.PI * 2);
        ctx.stroke();
      }

      // ── The body: three warped blobs, added as light ──
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const N = 120;
      const wob = reduce ? 0 : 0.035 + e * 0.22 + st.think * 0.03;
      BLOBS.forEach((b, bi) => {
        const rot = st.spin * b.drift;
        const ox = Math.cos(t * 0.7 + bi * 2.1) * R * 0.05 * (1 + e);
        const oy = Math.sin(t * 0.9 + bi * 1.3) * R * 0.05 * (1 + e);
        ctx.beginPath();
        for (let i = 0; i <= N; i++) {
          const th = (i / N) * Math.PI * 2;
          let d = 0;
          for (const [h, sp, p0] of b.waves) d += Math.sin(h * (th + rot) + t * sp * (1 + e * 2.5) + p0) / h;
          const rr = R * b.scale * (1 + wob * d * 0.6);
          const x = c + ox + Math.cos(th) * rr;
          const y = c + oy + Math.sin(th) * rr;
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
        const col = bi === 0 ? pal.mid : bi === 1 ? mix(pal.mid, pal.accent, 0.55) : mix(pal.edge, pal.accent, 0.3);
        const bg = ctx.createRadialGradient(c + ox - R * 0.25, c + oy - R * 0.3, R * 0.05, c + ox, c + oy, R * b.scale * 1.15);
        bg.addColorStop(0, rgba(mix(pal.core, col, 0.25), 0.55 * b.alpha));
        bg.addColorStop(0.55, rgba(col, 0.42 * b.alpha));
        bg.addColorStop(1, rgba(pal.edge, 0.18 * b.alpha));
        ctx.fillStyle = bg;
        ctx.fill();
      });
      ctx.restore();

      // ── A bright core and a drifting highlight ──
      const coreR = R * (0.62 + e * 0.12);
      g = ctx.createRadialGradient(c, c, 0, c, c, coreR);
      g.addColorStop(0, rgba(pal.core, 0.95));
      g.addColorStop(0.35, rgba(pal.core, 0.55 + e * 0.3));
      g.addColorStop(1, rgba(pal.core, 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(c, c, coreR, 0, Math.PI * 2);
      ctx.fill();
      const hx = c + Math.cos(t * 0.6) * R * 0.28 - R * 0.12;
      const hy = c + Math.sin(t * 0.45) * R * 0.22 - R * 0.2;
      g = ctx.createRadialGradient(hx, hy, 0, hx, hy, R * 0.42);
      g.addColorStop(0, 'rgba(255,255,255,0.55)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(hx, hy, R * 0.42, 0, Math.PI * 2);
      ctx.fill();

      // ── Thinking: a comet circling ──
      if (st.think > 0.02 && !reduce) {
        const orbit = R * 1.32;
        const head = st.spin * 1.6;
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < 26; i++) {
          const a = head - i * 0.07;
          const fade = (1 - i / 26) * st.think;
          ctx.fillStyle = rgba(i < 3 ? pal.core : pal.accent, fade * 0.8);
          ctx.beginPath();
          ctx.arc(c + Math.cos(a) * orbit, c + Math.sin(a) * orbit, Math.max(0.4, size * 0.016 * (1 - i / 30)), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      // ── Speaking: sparks thrown off with the voice ──
      if (!reduce) {
        if (ph === 'speaking' && st.energy > 0.15 && Math.random() < st.energy * 0.9) {
          st.sparks.push({ angle: Math.random() * Math.PI * 2, radius: R * 0.95, speed: R * (0.5 + Math.random() * 0.9), size: size * (0.006 + Math.random() * 0.01), life: 0.9 + Math.random() * 0.6, born: now });
        }
        st.sparks = st.sparks.filter(s => (now - s.born) / 1000 < s.life);
        if (st.sparks.length > 80) st.sparks.splice(0, st.sparks.length - 80);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (const s of st.sparks) {
          const age = (now - s.born) / 1000;
          const f = age / s.life;
          const rr = s.radius + s.speed * age;
          const fade = Math.max(0, Math.min(1, (edge - s.size - rr) / (size * 0.1)));
          if (fade <= 0) continue;
          const a = s.angle + age * 0.6;
          ctx.fillStyle = rgba(mix(pal.accent, pal.core, 0.3), (1 - f) * 0.85 * fade);
          ctx.beginPath();
          ctx.arc(c + Math.cos(a) * rr, c + Math.sin(a) * rr, s.size * (1 - f * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }

      if (visible) raf = requestAnimationFrame(draw);
    };

    const io = new IntersectionObserver(([en]) => {
      visible = !!en?.isIntersecting;
      if (visible && !raf) { last = performance.now(); raf = requestAnimationFrame(draw); }
    });
    io.observe(canvas);
    raf = requestAnimationFrame(draw);
    return () => { io.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [size]);

  return (
    <canvas
      ref={ref}
      onClick={onClick}
      title={title}
      className={className}
      style={{ width: size, height: size, cursor: onClick ? 'pointer' : undefined, display: 'block', ...style }}
    />
  );
}
