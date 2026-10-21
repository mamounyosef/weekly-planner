// The real assistant panel on its own page, for testing voice mode in a
// browser without the planner around it (see scripts/voice-harness.ts).

import React from 'react';
import { createRoot } from 'react-dom/client';

import AgentPanel from '@/components/agent/AgentPanel';

const theme = {
  darkMode: true,
  text: '#e6e8ee',
  sub: '#9aa3b2',
  bg: '#14171d',
  bdr: 'rgba(255,255,255,0.09)',
  surface: '#1b1f27',
  hover: 'rgba(255,255,255,0.07)',
  accent: '#38bdf8',
};

function Harness() {
  return (
    <div style={{ display: 'flex', height: '100%', justifyContent: 'flex-end' }}>
      <AgentPanel open onClose={() => {}} theme={theme} timeFormat="12h" fullscreen={false} width={460} onResize={() => {}} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
