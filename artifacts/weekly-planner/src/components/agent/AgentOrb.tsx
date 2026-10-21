// The assistant's mark: a glowing orb of light, the same one the Notes app's
// assistant wears (white core, periwinkle body, edge fading to nothing).
//
// It is alive rather than a picture: the core breathes, a soft highlight
// drifts around inside it, and the glow behind it swells and settles. While the
// assistant is working everything quickens and a ring ripples outwards, so
// "busy" reads at a glance without any text. Reduced-motion users get the
// still orb.

import React from 'react';

/** The Notes app's accent, and the colour of the orb's body. */
export const ORB_ACCENT = '#7c9cff';

const ORB_CSS = `
@keyframes agent-orb-breathe { 0%, 100% { transform: scale(0.94) } 50% { transform: scale(1.04) } }
@keyframes agent-orb-glow { 0%, 100% { opacity: 0.45; transform: scale(0.9) } 50% { opacity: 0.85; transform: scale(1.12) } }
@keyframes agent-orb-ripple { 0% { opacity: 0.55; transform: scale(0.7) } 100% { opacity: 0; transform: scale(1.65) } }
@keyframes agent-orb-flicker { 0%, 100% { opacity: 0.9 } 40% { opacity: 1 } 70% { opacity: 0.8 } }
.agent-orb { position: relative; display: inline-block; flex-shrink: 0; isolation: isolate; }
.agent-orb > span { position: absolute; border-radius: 9999px; pointer-events: none; }
.agent-orb-halo { inset: -22%; z-index: -1; filter: blur(3px);
  background: radial-gradient(circle, rgba(124,156,255,0.55) 0%, rgba(124,156,255,0.18) 45%, rgba(124,156,255,0) 70%); }
.agent-orb-core { inset: 0;
  background: radial-gradient(circle at 50% 50%, #ffffff 0%, #c4d2ff 25%, rgba(124,156,255,0.9) 70%, rgba(124,156,255,0) 100%); }
.agent-orb-ripple { inset: 0; border: 1.5px solid rgba(124,156,255,0.7); opacity: 0; }
.agent-orb.is-live .agent-orb-core { animation: agent-orb-breathe 4.2s ease-in-out infinite, agent-orb-flicker 3.1s ease-in-out infinite; }
.agent-orb.is-live .agent-orb-halo { animation: agent-orb-glow 4.2s ease-in-out infinite; }
.agent-orb.is-calm .agent-orb-halo { animation: agent-orb-glow 6s ease-in-out infinite; }
.agent-orb.is-busy .agent-orb-core { animation: agent-orb-breathe 1.15s ease-in-out infinite, agent-orb-flicker 0.9s ease-in-out infinite; }
.agent-orb.is-busy .agent-orb-halo { animation: agent-orb-glow 1.15s ease-in-out infinite; }
.agent-orb.is-busy .agent-orb-ripple { animation: agent-orb-ripple 1.4s cubic-bezier(0.2, 0.6, 0.3, 1) infinite; }
.agent-orb.is-busy .agent-orb-ripple.r2 { animation-delay: 0.7s; }
.agent-orb-tile { display: inline-grid; place-items: center; flex-shrink: 0; }
@media (prefers-reduced-motion: reduce) {
  .agent-orb.is-live > span, .agent-orb.is-busy > span, .agent-orb.is-calm > span { animation: none !important; }
}
`;

let injected = false;
function injectCss() {
  if (injected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.textContent = ORB_CSS;
  document.head.appendChild(el);
  injected = true;
}

export default function AgentOrb({ size = 24, busy = false, still = false, tile, style }: {
  size?: number;
  busy?: boolean;
  /** Calm idle motion only (small places such as the toolbar): a slow glow and drift, no breathing. */
  still?: boolean;
  /**
   * Sit on a rounded tile, as the Notes app shows it in its header and empty
   * state. Colours come from the panel theme.
   */
  tile?: { bg: string; border: string; radius?: number; pad?: number; glow?: boolean };
  style?: React.CSSProperties;
}) {
  injectCss();
  const orb = (
    <span
      aria-hidden
      className={`agent-orb ${busy ? 'is-busy' : still ? 'is-calm' : 'is-live'}`}
      style={{ width: size, height: size, ...(tile ? {} : style) }}
    >
      <span className="agent-orb-halo" />
      <span className="agent-orb-core" />
      <span className="agent-orb-ripple" />
      <span className="agent-orb-ripple r2" />
    </span>
  );
  if (!tile) return orb;
  const pad = tile.pad ?? Math.round(size * 0.3);
  return (
    <span
      aria-hidden
      className="agent-orb-tile"
      style={{
        width: size + pad * 2,
        height: size + pad * 2,
        borderRadius: tile.radius ?? Math.round((size + pad * 2) * 0.3),
        background: tile.bg,
        boxShadow: `inset 0 0 0 1px ${tile.border}${tile.glow ? `, 0 10px 40px ${ORB_ACCENT}38` : ''}`,
        ...style,
      }}
    >
      {orb}
    </span>
  );
}

/** Same mark, shaped like a lucide icon component, for icon slots. */
export function AgentOrbIcon({ size = 16 }: { size?: number; strokeWidth?: number }) {
  return <AgentOrb size={Math.round(size * 0.95)} still />;
}
