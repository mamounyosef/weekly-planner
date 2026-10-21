// Voice mode inside the assistant panel: the orb, what is being said right
// now, and the few controls a conversation needs. It takes the composer's
// place; the chat above keeps the full back-and-forth in text, with the same
// change reports, Undo and Approve cards as a typed chat.

import React, { useEffect, useState } from 'react';
import { Brain, Mic, MicOff, PhoneOff, Square, Check } from 'lucide-react';

import type { AgentTheme } from '../agent/AgentCards';
import ModelPicker, { type PickerSpeed } from '../agent/ModelPicker';
import VoiceOrbCanvas from './VoiceOrbCanvas';
import type { VoiceConversation } from '@/lib/voice/useVoiceConversation';

const DOCK_CSS = `
@keyframes voice-dots { 0%, 80%, 100% { opacity: 0.25 } 40% { opacity: 1 } }
.voice-dots > i { display: inline-block; width: 4px; height: 4px; border-radius: 9999px; background: currentColor; margin-left: 3px; animation: voice-dots 1.2s infinite ease-in-out; }
.voice-dots > i:nth-child(2) { animation-delay: 0.15s } .voice-dots > i:nth-child(3) { animation-delay: 0.3s }
@keyframes voice-caption-in { from { opacity: 0; transform: translateY(4px); filter: blur(2px) } to { opacity: 1; transform: none; filter: none } }
.voice-caption { animation: voice-caption-in 220ms ease-out both; }
.voice-btn { transition: transform 120ms ease, background 140ms ease, box-shadow 160ms ease; }
.voice-btn:hover { transform: translateY(-1px); }
.voice-btn:active { transform: scale(0.95); }
`;

export const PHASE_LABEL: Record<string, string> = {
  connecting: 'Connecting',
  loading: 'Waking up the voice engine',
  listening: 'Listening',
  hearing: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Something went wrong',
  ended: 'Voice mode ended',
};

const PHASE_TINT: Record<string, string> = {
  listening: '#60a5fa', hearing: '#38bdf8', thinking: '#a78bfa', speaking: '#fb923c',
  connecting: '#94a3b8', loading: '#94a3b8', error: '#f87171', ended: '#94a3b8',
};

export default function VoiceDock({ voice, theme, model, onPickModel, speed, think, onThink, compact }: {
  voice: VoiceConversation;
  theme: AgentTheme;
  model: string;
  onPickModel: (id: string) => void;
  speed: PickerSpeed;
  think: boolean;
  onThink: (on: boolean) => void;
  /** A short panel: a smaller orb. */
  compact?: boolean;
}) {
  const { phase, muted } = voice;
  const busy = phase === 'connecting' || phase === 'loading' || phase === 'thinking';
  const tint = muted && phase !== 'speaking' ? '#9ca3af' : PHASE_TINT[phase] ?? theme.sub;
  const label = muted && (phase === 'listening' || phase === 'hearing') ? 'Muted' : PHASE_LABEL[phase] ?? '';
  const orbSize = compact ? 150 : 200;

  // The last thing said stays readable for a moment after it is done.
  const [caption, setCaption] = useState<{ who: 'you' | 'ai'; text: string; live: boolean } | null>(null);
  useEffect(() => {
    if (voice.saying) setCaption({ who: 'ai', text: voice.saying, live: true });
    else if (voice.heard) setCaption({ who: 'you', text: voice.heard, live: !voice.heardFinal });
  }, [voice.saying, voice.heard, voice.heardFinal]);
  useEffect(() => {
    if (voice.saying || voice.heard) return;
    const t = setTimeout(() => setCaption(null), 2500);
    return () => clearTimeout(t);
  }, [voice.saying, voice.heard]);

  // Keys while talking: Esc ends, M mutes, Enter = "I'm done", Space stops it talking.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      // A model menu is open: Esc closes just that, and keys must not act on the call.
      if (document.querySelector('[data-model-menu]')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); voice.stop(); }
      else if (e.key === 'm' || e.key === 'M') { e.preventDefault(); voice.setMuted(!voice.muted); }
      else if (e.key === 'Enter') { e.preventDefault(); voice.finishTurn(); }
      else if (e.key === ' ') { e.preventDefault(); voice.interrupt(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [voice]);

  const onOrb = () => {
    if (phase === 'speaking') voice.interrupt();
    else if (phase === 'hearing') voice.finishTurn();
    else voice.setMuted(!muted);
  };
  const orbTitle = phase === 'speaking' ? 'Tap to stop it talking' : phase === 'hearing' ? "Tap when you're done" : muted ? 'Tap to unmute' : 'Tap to mute';

  return (
    <div className="flex-shrink-0 relative px-3 pt-1 pb-3 agent-in" style={{ background: `linear-gradient(to top, ${theme.bg} 78%, transparent)` }}>
      <style>{DOCK_CSS}</style>
      <div
        className="rounded-[26px] relative"
        style={{
          border: `1px solid ${theme.bdr}`,
          background: theme.darkMode
            ? `radial-gradient(120% 90% at 50% 38%, ${tint}22 0%, transparent 60%), ${theme.surface}`
            : `radial-gradient(120% 90% at 50% 38%, ${tint}26 0%, transparent 60%), ${theme.surface}`,
          boxShadow: theme.darkMode ? '0 14px 40px rgba(0,0,0,0.4)' : '0 14px 36px rgba(15,23,42,0.10)',
          transition: 'background 600ms ease',
        }}
      >
        <div className="flex items-center gap-1 px-2 pt-2">
          <ModelPicker model={model} onPick={onPickModel} theme={theme} speed={speed} label="Voice" />
          <button
            type="button"
            onClick={() => onThink(!think)}
            title={think ? 'Thinking before answering: more careful, slower. Click for quick answers.' : 'Quick answers. Click to let it think before answering (more careful, slower).'}
            className="h-7 px-2.5 rounded-full text-[11px] font-semibold inline-flex items-center gap-1 transition-colors"
            style={{ color: think ? '#a78bfa' : theme.sub, background: think ? 'rgba(167,139,250,0.14)' : 'transparent', border: `1px solid ${think ? 'rgba(167,139,250,0.35)' : theme.bdr}` }}
          >
            <Brain size={12} /> {think ? 'Thinks first' : 'Quick'}
          </button>
          <div className="flex-1" />
          <span className="text-[10.5px] pr-2 hidden sm:inline" style={{ color: theme.sub, opacity: 0.8 }}>Esc ends · M mutes</span>
        </div>

        <div className="flex flex-col items-center pt-1">
          <VoiceOrbCanvas size={orbSize} phase={phase} muted={muted} levels={voice.levels} onClick={onOrb} title={orbTitle} />
          <div className="mt-0.5 h-5 flex items-center text-[12.5px] font-semibold tracking-tight" style={{ color: tint, transition: 'color 400ms ease' }}>
            {label}
            {busy && <span className="voice-dots ml-0.5"><i /><i /><i /></span>}
          </div>
          <div className="w-full px-5 mt-1.5 mb-1 h-[42px] flex items-start justify-center text-center overflow-hidden">
            {voice.error ? (
              <div className="text-[12px] leading-snug voice-caption" style={{ color: '#f87171' }}>{voice.error}</div>
            ) : caption ? (
              <div key={`${caption.who}:${caption.who === 'ai' ? caption.text : ''}`} className="voice-caption text-[13px] leading-snug line-clamp-2" dir="auto"
                style={{ color: caption.who === 'you' ? theme.text : theme.text, opacity: caption.live ? 1 : 0.75 }}>
                <span className="font-semibold mr-1" style={{ color: caption.who === 'you' ? '#60a5fa' : '#fb923c' }}>{caption.who === 'you' ? 'You' : 'Assistant'}</span>
                <span style={{ fontStyle: caption.who === 'you' && caption.live ? 'italic' : undefined }}>{caption.text}</span>
              </div>
            ) : (
              <div className="text-[12px]" style={{ color: theme.sub }}>
                {phase === 'loading' ? 'First start takes a few seconds while the voice models load on your GPU.'
                  : phase === 'listening' && !muted ? 'Just talk. Pause when you are done.' : ''}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-center gap-2.5 pb-3">
          <DockButton theme={theme} title={muted ? 'Unmute (M)' : 'Mute (M)'} onClick={() => voice.setMuted(!muted)} active={muted}>
            {muted ? <MicOff size={17} /> : <Mic size={17} />}
          </DockButton>
          {phase === 'speaking' ? (
            <DockButton theme={theme} title="Stop talking (Space)" onClick={voice.interrupt}>
              <Square size={14} fill="currentColor" />
            </DockButton>
          ) : (
            <DockButton theme={theme} title="I'm done talking (Enter)" onClick={voice.finishTurn} disabled={phase !== 'hearing'}>
              <Check size={17} />
            </DockButton>
          )}
          <button
            type="button"
            onClick={voice.stop}
            title="End voice mode (Esc)"
            className="voice-btn h-11 px-4 rounded-full flex items-center gap-2 text-[12.5px] font-semibold text-white"
            style={{ background: 'linear-gradient(135deg, #f43f5e, #e11d48)', boxShadow: '0 6px 18px rgba(225,29,72,0.35)' }}
          >
            <PhoneOff size={16} /> End
          </button>
        </div>
      </div>
    </div>
  );
}

function DockButton({ theme, title, onClick, active, disabled, children }: {
  theme: AgentTheme; title: string; onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="voice-btn h-11 w-11 rounded-full flex items-center justify-center"
      style={{
        color: active ? '#fff' : theme.text,
        background: active ? '#64748b' : theme.hover,
        border: `1px solid ${theme.bdr}`,
        opacity: disabled ? 0.4 : 1,
      }}
    >
      {children}
    </button>
  );
}
