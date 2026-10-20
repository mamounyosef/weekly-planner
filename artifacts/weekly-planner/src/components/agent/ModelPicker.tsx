// The model chooser: the model's name in the composer, and every model's
// details in the menu above it (size, experts, context window, release date,
// architecture, price). The same catalogue and layout as the Notes app's
// assistant, Ollama only. The choice belongs to this device.

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Image as ImageIcon } from 'lucide-react';

import {
  MODELS, VISION_MODEL, fmtCtx, fmtDate, fmtMoney, fmtTokens, modelInfo, paramsLabel, priceLabel, type ModelInfo,
} from '@/lib/agent/agentModels';
import type { AgentUsage } from '@/lib/agent/agentTypes';
import type { AgentTheme } from './AgentCards';

const VISION = '#56b6c2';
const FREE_GREEN = '#98c379';

function PriceLine({ m, theme }: { m: ModelInfo; theme: AgentTheme }) {
  if (!m.price) return <span style={{ fontStyle: 'italic', color: theme.sub }}>Price not listed</span>;
  return (
    <span title="US dollars per million tokens (ollama.com/pricing)" style={{ color: theme.sub }}>
      {priceLabel(m).replace(' / 1M', '')} <span style={{ opacity: 0.7 }}>/ 1M</span>
    </span>
  );
}

export default function ModelPicker({ model, onPick, theme, usage, chatCost, disabled }: {
  model: string;
  onPick: (id: string) => void;
  theme: AgentTheme;
  /** The latest reply's usage in this chat, for the context meter. */
  usage?: AgentUsage | null;
  /** What the whole chat has cost so far; null when a model without a price was used. */
  chatCost?: number | null;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = modelInfo(model);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    window.addEventListener('mousedown', close);
    window.addEventListener('touchstart', close);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('touchstart', close);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const ctxModel = usage ? modelInfo(usage.model) : cur;
  const ctxPct = usage && usage.contextTokens > 0 ? Math.min(100, (usage.contextTokens / ctxModel.context) * 100) : 0;

  return (
    <div ref={ref} className="static">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(v => !v)}
        title={`${cur.name} on Ollama: ${paramsLabel(cur)}, ${fmtCtx(cur.context)} context${cur.released ? `, released ${fmtDate(cur.released)}` : ''}`}
        className="h-8 px-2.5 rounded-full flex items-center gap-1 text-[12px] font-medium whitespace-nowrap transition-colors max-w-[180px]"
        style={{ color: open ? theme.text : theme.sub, background: open ? theme.hover : 'transparent', opacity: disabled ? 0.5 : 1 }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = theme.hover; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        <span className="truncate">{cur.name}</span>
        <ChevronDown size={12} className="flex-shrink-0 transition-transform" style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div
          className="agent-in agent-scroll absolute z-30 overflow-y-auto overscroll-contain"
          style={{
            left: 8, right: 8, bottom: 'calc(100% + 4px)', maxHeight: 'min(520px, 62vh)',
            background: theme.surface, border: `1px solid ${theme.bdr}`, borderRadius: 14, padding: 6,
            boxShadow: theme.darkMode ? '0 18px 50px rgba(0,0,0,0.5)' : '0 18px 50px rgba(15,23,42,0.18)',
          }}
          onKeyDown={e => e.stopPropagation()}
        >
          <div className="flex items-baseline gap-1.5 px-2 pt-1.5 pb-1">
            <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: theme.sub }}>Model</span>
            <span className="text-[11px]" style={{ color: theme.sub, opacity: 0.7 }}>strongest first</span>
          </div>

          {usage && usage.contextTokens > 0 && (
            <div className="mx-2 mb-1.5 mt-0.5">
              <div className="flex items-center justify-between text-[10.5px] tabular-nums" style={{ color: theme.sub }}>
                <span>This chat: {fmtTokens(usage.contextTokens)} of {fmtCtx(ctxModel.context)} context</span>
                {chatCost !== undefined && <span>{chatCost === null ? 'cost not listed' : `${fmtMoney(chatCost)} so far`}</span>}
              </div>
              <div className="h-1 rounded-full mt-1 overflow-hidden" style={{ background: theme.hover }}>
                <div className="h-full rounded-full" style={{ width: `${Math.max(1.5, ctxPct)}%`, background: ctxPct > 80 ? '#f59e0b' : `linear-gradient(90deg, #c4d2ff, #7c9cff)` }} />
              </div>
            </div>
          )}

          {MODELS.map(m => {
            const sel = m.id === model;
            return (
              <button
                key={m.id}
                type="button"
                onClick={() => { onPick(m.id); setOpen(false); }}
                className="w-full text-left rounded-lg px-2.5 py-2 flex flex-col gap-0.5 transition-colors"
                style={{ background: sel ? `${theme.accent}1f` : 'transparent' }}
                onMouseEnter={e => { if (!sel) e.currentTarget.style.background = theme.hover; }}
                onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
              >
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-semibold" style={{ color: theme.text }}>{m.name}</span>
                  <span className="text-[10px] px-1.5 py-px rounded-md tracking-[0.02em]" style={{ color: theme.sub, background: theme.hover }} title="Runs on Ollama Cloud">Ollama</span>
                  {m.vision && (
                    <span className="text-[10.5px] px-1.5 py-px rounded-md inline-flex items-center gap-1" style={{ color: VISION, background: `${VISION}24` }} title="Can see images">
                      <ImageIcon size={11} /> vision
                    </span>
                  )}
                  {sel && <Check size={13} className="ml-auto flex-shrink-0" style={{ color: theme.accent }} />}
                </div>
                <div className="flex flex-wrap gap-x-2.5 text-[11.5px] tabular-nums" style={{ color: theme.sub }}>
                  <span>{paramsLabel(m)}</span>
                  <span>{fmtCtx(m.context)} context</span>
                  <span>{fmtDate(m.released)}</span>
                </div>
                {m.arch.length > 0 && (
                  <div className="text-[11px] leading-snug" style={{ color: theme.sub, opacity: 0.85 }}>{m.arch.join(' · ')}</div>
                )}
                <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-[11px]">
                  <PriceLine m={m} theme={theme} />
                  {m.note && <span style={{ color: theme.sub, opacity: 0.8 }}>{m.note}</span>}
                  {!m.vision && <span style={{ color: theme.sub, opacity: 0.8 }}>Images read by {modelInfo(VISION_MODEL).name}.</span>}
                </div>
              </button>
            );
          })}

          <div className="text-[10.5px] px-2.5 pt-1.5 pb-1 mt-1" style={{ color: theme.sub, borderTop: `1px solid ${theme.bdr}` }}>
            Prices from ollama.com/pricing; your plan's monthly credits are used first.{' '}
            <span style={{ color: FREE_GREEN }}>All of these run on your free usage credits.</span>{' '}
            Your pick is remembered on this device only.
          </div>
        </div>
      )}
    </div>
  );
}
