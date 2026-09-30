// The assistant's mark: a soft sky-blue orb rather than a robot or a
// sparkle glyph. It breathes while idle and a highlight sweeps around it while
// the assistant is working, so "busy" reads without any text.

import React from 'react';

const ORB_CSS = `
@keyframes agent-orb-spin { to { transform: rotate(360deg) } }
@keyframes agent-orb-breathe { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.045) } }
.agent-orb { position: relative; border-radius: 9999px; flex-shrink: 0; overflow: hidden;
  background: radial-gradient(circle at 32% 26%, #f0f9ff 0%, #bae6fd 14%, #38bdf8 38%, #0284c7 68%, #1e40af 100%);
  box-shadow: inset 0 -2px 6px rgba(30,64,175,0.45), inset 0 2px 4px rgba(255,255,255,0.35), 0 3px 12px rgba(14,165,233,0.35); }
.agent-orb::after { content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: radial-gradient(circle at 70% 78%, rgba(125,211,252,0.55), transparent 45%); }
.agent-orb.is-idle { animation: agent-orb-breathe 4.5s ease-in-out infinite; }
.agent-orb .agent-orb-sweep { position: absolute; inset: -30%; opacity: 0; transition: opacity 300ms;
  background: conic-gradient(from 0deg, transparent 0deg, rgba(255,255,255,0.75) 40deg, transparent 90deg); }
.agent-orb.is-busy .agent-orb-sweep { opacity: 1; animation: agent-orb-spin 1.1s linear infinite; }
`;

let injected = false;
function injectCss() {
  if (injected || typeof document === 'undefined') return;
  const el = document.createElement('style');
  el.textContent = ORB_CSS;
  document.head.appendChild(el);
  injected = true;
}

export default function AgentOrb({ size = 24, busy = false, still = false, style }: {
  size?: number;
  busy?: boolean;
  /** No idle breathing (for small uses such as the toolbar). */
  still?: boolean;
  style?: React.CSSProperties;
}) {
  injectCss();
  return (
    <span
      aria-hidden
      className={`agent-orb ${busy ? 'is-busy' : still ? '' : 'is-idle'}`}
      style={{ width: size, height: size, display: 'inline-block', ...style }}
    >
      <span className="agent-orb-sweep" />
    </span>
  );
}

/** Same mark, shaped like a lucide icon component, for icon slots. */
export function AgentOrbIcon({ size = 16 }: { size?: number; strokeWidth?: number }) {
  return <AgentOrb size={Math.round(size * 0.95)} still />;
}
