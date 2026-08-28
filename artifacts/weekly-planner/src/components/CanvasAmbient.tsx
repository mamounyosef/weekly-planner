// The canvas ambient layer, and the miniature of it shown in Settings.
//
// Both live here on purpose: the settings preview is built from the SAME spec
// the real pages render, so a preview can never quietly drift from what the
// planner actually looks like. Change a number here and both move together.

import type { SidebarStyle } from '@/lib/settingsSync';

export interface AmbientSpec {
  /** Opacity of the left (indigo/blue) aura blob. */
  leftOpacity: number;
  /** Opacity of the right (emerald) aura blob. */
  rightOpacity: number;
  /** Micro-dot texture opacity. 0 = a truly flat canvas. */
  dotOpacity: number;
  /** Frosted sheen wash laid over the canvas (glass style only). */
  frost: boolean;
}

export const AMBIENT_SPECS: Record<SidebarStyle, AmbientSpec> = {
  'minimal-flat':      { leftOpacity: 0,    rightOpacity: 0,    dotOpacity: 0,    frost: false },
  'glass-translucent': { leftOpacity: 0.35, rightOpacity: 0.25, dotOpacity: 0.9,  frost: true  },
  'subtle-glow':       { leftOpacity: 0.5,  rightOpacity: 0.4,  dotOpacity: 1,    frost: false },
  'accent-aura':       { leftOpacity: 0.95, rightOpacity: 0.85, dotOpacity: 1,    frost: false },
};

/** Base dot opacity before the per-style multiplier above. */
const DOT_BASE = (dark: boolean) => (dark ? 0.06 : 0.035);

const leftAura = (dark: boolean) => dark
  ? 'radial-gradient(circle, rgba(59,130,246,0.18) 0%, rgba(99,102,241,0.06) 65%, transparent 100%)'
  : 'radial-gradient(circle, rgba(99,102,241,0.10) 0%, rgba(192,132,252,0.04) 65%, transparent 100%)';

const rightAura = (dark: boolean) => dark
  ? 'radial-gradient(circle, rgba(16,185,129,0.14) 0%, rgba(59,130,246,0.04) 65%, transparent 100%)'
  : 'radial-gradient(circle, rgba(16,185,129,0.08) 0%, rgba(59,130,246,0.03) 65%, transparent 100%)';

/** The frosted sheen: a soft diagonal glass wash. No backdrop-filter — that put
 *  the whole page on the expensive compositing path on the phone. */
const frostWash = (dark: boolean) => dark
  ? 'linear-gradient(135deg, rgba(255,255,255,0.055) 0%, rgba(255,255,255,0.012) 42%, rgba(255,255,255,0.0) 70%, rgba(255,255,255,0.035) 100%)'
  : 'linear-gradient(135deg, rgba(255,255,255,0.75) 0%, rgba(255,255,255,0.25) 42%, rgba(255,255,255,0.0) 70%, rgba(255,255,255,0.5) 100%)';

/**
 * Full-page ambient background. Sits behind everything, never takes pointer
 * events. Rendered identically by the planner and the settings page.
 */
export function CanvasAmbient({ style, dark }: { style: SidebarStyle; dark: boolean }) {
  const spec = AMBIENT_SPECS[style] ?? AMBIENT_SPECS['subtle-glow'];
  return (
    <div
      className="fixed inset-0 pointer-events-none z-0 overflow-hidden gpu-layer"
      style={{ contain: 'strict' }}
    >
      <div
        className="ambient-aura-blob absolute -top-20 -left-20 w-[300px] h-[300px] md:-top-32 md:-left-32 md:w-[600px] md:h-[600px] rounded-full blur-[160px] pointer-events-none transition-opacity duration-300"
        style={{
          background: leftAura(dark),
          opacity: spec.leftOpacity,
          contain: 'paint layout',
          transform: 'translate3d(0,0,0)',
        }}
      />
      <div
        className="ambient-aura-blob absolute top-1/3 -right-20 w-[300px] h-[300px] md:-right-32 md:w-[600px] md:h-[600px] rounded-full blur-[160px] pointer-events-none transition-opacity duration-300"
        style={{
          background: rightAura(dark),
          opacity: spec.rightOpacity,
          contain: 'paint layout',
          transform: 'translate3d(0,0,0)',
        }}
      />
      {spec.frost && (
        <div
          className="absolute inset-0 pointer-events-none transition-opacity duration-300"
          style={{ background: frostWash(dark), opacity: dark ? 1 : 0.55, transform: 'translate3d(0,0,0)' }}
        />
      )}
      {/* Micro-dots texture: rendered on desktop screens only to preserve 100% fill-rate on mobile GPUs */}
      <div
        className="hidden md:block absolute inset-0 pointer-events-none transition-opacity duration-300"
        style={{
          backgroundImage: `radial-gradient(${dark ? 'rgba(255,255,255,0.8)' : 'rgba(15,23,42,0.8)'} 1px, transparent 1px)`,
          backgroundSize: spec.frost ? '16px 16px' : '28px 28px',
          opacity: DOT_BASE(dark) * spec.dotOpacity,
          transform: 'translate3d(0,0,0)',
        }}
      />
    </div>
  );
}

/**
 * The Settings thumbnail. Same layers, same spec, scaled down — the blob size
 * and blur shrink by the same factor so the proportions read true.
 */
export function CanvasAmbientPreview({
  style, dark, pageBg, height = 74,
}: { style: SidebarStyle; dark: boolean; pageBg: string; height?: number }) {
  const spec = AMBIENT_SPECS[style] ?? AMBIENT_SPECS['subtle-glow'];
  // Aura opacities are tuned for a 600px blob under a 160px blur across a whole
  // window. In a thumbnail that reads far too faint, so lift it uniformly —
  // the *relative* order between the four styles is what the preview has to show.
  // The real gradients are tuned for a 600px blob under a 160px blur across a
  // whole window; shrunk to a thumbnail they read as nothing. So the PREVIEW
  // strengthens the gradient itself and leaves each style's opacity untouched —
  // boosting the opacity instead clamps Subtle and Vivid to the same 1.0 and
  // makes those two thumbnails identical, which is the exact confusion this
  // preview exists to remove.
  const pvLeft = dark
    ? 'radial-gradient(circle, rgba(59,130,246,0.85) 0%, rgba(99,102,241,0.30) 60%, transparent 100%)'
    : 'radial-gradient(circle, rgba(99,102,241,0.60) 0%, rgba(192,132,252,0.22) 60%, transparent 100%)';
  const pvRight = dark
    ? 'radial-gradient(circle, rgba(16,185,129,0.70) 0%, rgba(59,130,246,0.22) 60%, transparent 100%)'
    : 'radial-gradient(circle, rgba(16,185,129,0.50) 0%, rgba(59,130,246,0.18) 60%, transparent 100%)';
  return (
    <div
      className="relative w-full overflow-hidden rounded-xl"
      style={{ height, background: pageBg }}
    >
      <div
        className="absolute rounded-full"
        style={{
          top: -46, left: -46, width: 150, height: 150,
          filter: 'blur(22px)',
          background: pvLeft,
          opacity: spec.leftOpacity,
        }}
      />
      <div
        className="absolute rounded-full"
        style={{
          top: '20%', right: -46, width: 150, height: 150,
          filter: 'blur(22px)',
          background: pvRight,
          opacity: spec.rightOpacity,
        }}
      />
      {spec.frost && (
        <div className="absolute inset-0" style={{ background: frostWash(dark), opacity: dark ? 1 : 0.55 }} />
      )}
      <div
        className="absolute inset-0"
        style={{
          backgroundImage: `radial-gradient(${dark ? 'rgba(255,255,255,0.8)' : 'rgba(15,23,42,0.8)'} 1px, transparent 1px)`,
          backgroundSize: spec.frost ? '10px 10px' : '16px 16px',
          opacity: DOT_BASE(dark) * spec.dotOpacity * 2.2,
        }}
      />
      {/* A stand-in for the planner panel, so the glow has something to sit behind. */}
      <div
        className="absolute rounded-md border"
        style={{
          left: 30, right: 30, top: 15, bottom: 13,
          background: dark ? 'rgba(255,255,255,0.045)' : '#ffffff',
          borderColor: dark ? 'rgba(255,255,255,0.10)' : 'rgba(15,23,42,0.10)',
        }}
      >
        <div className="absolute left-0 right-0 top-0 h-[7px] border-b" style={{ borderColor: dark ? 'rgba(255,255,255,0.08)' : 'rgba(15,23,42,0.07)' }} />
        {[22, 44].map(t => (
          <div key={t} className="absolute left-0 right-0 border-b" style={{ top: t, borderColor: dark ? 'rgba(255,255,255,0.05)' : 'rgba(15,23,42,0.05)' }} />
        ))}
        <div className="absolute rounded-[3px]" style={{ left: 8, top: 12, width: 26, height: 15, background: '#3b82f6', opacity: 0.75 }} />
        <div className="absolute rounded-[3px]" style={{ left: 42, top: 24, width: 26, height: 19, background: '#10b981', opacity: 0.75 }} />
      </div>
    </div>
  );
}
