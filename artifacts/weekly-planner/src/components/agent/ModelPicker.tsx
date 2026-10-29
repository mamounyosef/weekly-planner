// The model chooser: the model's name in the composer, and every model's
// details in the menu above it (service, size, experts, context window,
// release date, thinking levels, architecture, price). The same catalogue and
// layout as the Notes app's assistant. In the chat's menu each thinking level
// is a button: one click picks the model and that level together. The choice
// belongs to this device.

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Gauge, Image as ImageIcon, Loader2, Star } from 'lucide-react';

import {
  MODELS, PROVIDER_LABEL, VISION_MODEL, expertsLabel, expertsTitle, fmtCtx, fmtDate, fmtMoney, fmtTokens, isFreeModel, modelInfo, paramsLabel, priceLabel, type ModelInfo,
} from '@/lib/agent/agentModels';
import { useFavModels } from '@/lib/agent/favModels';
import type { AgentUsage } from '@/lib/agent/agentTypes';
import type { ModelSpeed, ModelSpeeds } from '@/lib/agent/agentClient';
import { useThinkBook } from '@/lib/agent/thinkPrefs';
import type { AgentTheme } from './AgentCards';
import { THINK_CSS, ThinkTag, tkVars } from './ThinkControl';

const VISION = '#56b6c2';
const FREE_GREEN = '#98c379';
const OPENROUTER = '#c678dd';
const STAR = '#e5c07b';

// The star on each row: faint until the row is hovered, gold once starred, and
// a row that just moved between the parts glows for a moment.
const FAV_CSS = `
.mp-star { color: inherit; opacity: 0; cursor: pointer; transition: opacity .12s, color .12s, background .12s, transform .12s; }
.mp-row:hover .mp-star, .mp-row:focus-visible .mp-star, .mp-star:focus-visible { opacity: .6; }
.mp-star:hover { opacity: 1; color: ${STAR}; background: ${STAR}24; }
.mp-star:active { transform: scale(.86); }
.mp-star.on { opacity: 1; color: ${STAR}; }
.mp-moved .mp-star.on svg { animation: mp-star-pop .45s cubic-bezier(.3, 1.6, .5, 1); }
@keyframes mp-star-pop { 0% { transform: scale(.4) rotate(-40deg) } 100% { transform: scale(1) rotate(0) } }
.mp-moved { animation: mp-moved .9s ease-out; }
@keyframes mp-moved { 0% { box-shadow: inset 0 0 0 1px ${STAR}b3; background: ${STAR}1f } 100% { box-shadow: inset 0 0 0 1px transparent } }
@media (prefers-reduced-motion: reduce) { .mp-moved, .mp-moved .mp-star.on svg { animation: none } }
`;

function PriceLine({ m, theme }: { m: ModelInfo; theme: AgentTheme }) {
  if (!m.price) return <span style={{ fontStyle: 'italic', color: theme.sub }}>Price not listed</span>;
  if (isFreeModel(m)) {
    return (
      <span title="OpenRouter free model: 50 requests a day on a key without credits" style={{ color: FREE_GREEN }}>
        Free <span style={{ opacity: 0.7 }}>· 50 requests a day</span>
      </span>
    );
  }
  return (
    <span title="US dollars per million tokens (ollama.com/pricing)" style={{ color: theme.sub }}>
      {priceLabel(m).replace(' / 1M', '')} <span style={{ opacity: 0.7 }}>/ 1M</span>
    </span>
  );
}

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Voice mode's extra: how fast each model starts talking, measured on this PC. */
export interface PickerSpeed {
  speeds: ModelSpeeds;
  /** Which measurement applies: the voice "think before answering" setting. */
  mode: 'quick' | 'thinking';
  testing: boolean;
  error?: string | null;
  onTest: () => void;
}

function SpeedBadge({ s, other, mode, testing, theme }: { s?: ModelSpeed; other?: ModelSpeed; mode: 'quick' | 'thinking'; testing: boolean; theme: AgentTheme }) {
  if (!s) {
    return testing
      ? <span className="ml-auto text-[10.5px] inline-flex items-center gap-1" style={{ color: theme.sub }}><Loader2 size={10} className="animate-spin" /> timing</span>
      : <span className="ml-auto" />;
  }
  if (s.error || s.firstWordMs == null) {
    return <span className="ml-auto text-[10.5px]" style={{ color: '#f59e0b' }} title={s.error ?? 'Did not answer in words'}>no answer</span>;
  }
  const ms = s.firstWordMs;
  // Colour is only a hint for reading the list at a glance; the choice is yours.
  const color = ms < 2500 ? '#98c379' : ms < 5000 ? '#e5c07b' : '#e06c75';
  const otherMs = other && !other.error ? other.firstWordMs : null;
  return (
    <span
      className="ml-auto text-[11px] font-semibold tabular-nums px-1.5 py-px rounded-md inline-flex items-center gap-1"
      style={{ color, background: `${color}1f` }}
      title={`${mode === 'thinking' ? 'Thinking first' : 'Without thinking first'}: starts talking after ${fmtSec(ms)}${s.replyMs ? `, whole reply done after ${fmtSec(s.replyMs)}` : ''}.`
        + `${otherMs != null ? ` ${mode === 'thinking' ? 'Without' : 'With'} thinking: ${fmtSec(otherMs)}.` : ''}`
        + `${s.usedTools === false ? ' In the test it answered without looking at your calendar.' : ''}`}
    >
      {s.usedTools === false && <span style={{ color: '#e5c07b' }}>!</span>}
      <Gauge size={10} /> {fmtSec(ms)}
    </span>
  );
}

export default function ModelPicker({ model, onPick, theme, usage, chatCost, disabled, speed, label }: {
  model: string;
  onPick: (id: string) => void;
  theme: AgentTheme;
  /** The latest reply's usage in this chat, for the context meter. */
  usage?: AgentUsage | null;
  /** What the whole chat has cost so far; null when a model without a price was used. */
  chatCost?: number | null;
  disabled?: boolean;
  speed?: PickerSpeed;
  /** Shown before the model name on the button, e.g. "Voice". */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const cur = modelInfo(model);
  const think = useThinkBook();
  // Voice mode keeps its own thinking switch, so its menu only shows the levels.
  const chat = !speed;
  // Starred models come first, each part still strongest first.
  const { favs: favIds, toggle } = useFavModels();
  const favSet = new Set(favIds);
  const favs = MODELS.filter(m => favSet.has(m.id));
  const rest = MODELS.filter(m => !favSet.has(m.id));
  // The row that just moved between the parts glows briefly, so the eye can follow it.
  const [moved, setMoved] = useState<string | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const toggleFav = (id: string) => { toggle(id); setMoved(id); };

  useEffect(() => {
    if (!moved) return;
    menu.current?.querySelector(`[data-model="${CSS.escape(moved)}"]`)?.scrollIntoView({ block: 'nearest' });
    const t = setTimeout(() => setMoved(null), 900);
    return () => clearTimeout(t);
  }, [moved, favIds]);

  // Open on the current pick, wherever it sits in the list.
  useEffect(() => {
    if (open) menu.current?.querySelector('[data-sel]')?.scrollIntoView({ block: 'nearest' });
  }, [open]);

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
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        title={`${cur.name} on ${PROVIDER_LABEL[cur.provider]}: ${paramsLabel(cur)}, ${fmtCtx(cur.context)} context${cur.released ? `, released ${fmtDate(cur.released)}` : ''}`}
        className="h-8 px-2.5 rounded-full flex items-center gap-1 text-[12px] font-medium whitespace-nowrap transition-colors max-w-[180px]"
        style={{ color: open ? theme.text : theme.sub, background: open ? theme.hover : 'transparent', opacity: disabled ? 0.5 : 1 }}
        onMouseEnter={e => { if (!open) e.currentTarget.style.background = theme.hover; }}
        onMouseLeave={e => { if (!open) e.currentTarget.style.background = 'transparent'; }}
      >
        {label && <span className="flex-shrink-0" style={{ opacity: 0.7 }}>{label}:</span>}
        <span className="truncate">{cur.name}</span>
        {cur.provider === 'openrouter' && <span className="flex-shrink-0 text-[10px] ml-0.5" style={{ color: OPENROUTER }}>OpenRouter</span>}
        {speed && speed.speeds[speed.mode]?.[cur.id]?.firstWordMs != null && (
          <span className="flex-shrink-0 tabular-nums" style={{ color: theme.sub, opacity: 0.75 }}>{fmtSec(speed.speeds[speed.mode]![cur.id].firstWordMs!)}</span>
        )}
        <ChevronDown size={12} className="flex-shrink-0 transition-transform" style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && (
        <div
          ref={menu}
          data-model-menu
          className="agent-in agent-scroll absolute z-50 overflow-y-auto overscroll-contain"
          style={{
            left: 8, right: 8, bottom: 'calc(100% + 4px)', maxHeight: 'min(520px, 62vh)',
            // Theme surfaces can be translucent; lay them over a solid base so
            // the chat behind never shows through the menu.
            background: `linear-gradient(${theme.surface}, ${theme.surface}), ${theme.darkMode ? '#17191d' : '#ffffff'}`,
            border: `1px solid ${theme.bdr}`, borderRadius: 14, padding: 6,
            boxShadow: theme.darkMode ? '0 18px 50px rgba(0,0,0,0.5)' : '0 18px 50px rgba(15,23,42,0.18)',
            ...tkVars(theme),
          }}
          onKeyDown={e => e.stopPropagation()}
        >
          <style>{THINK_CSS}{FAV_CSS}</style>
          <div className="flex items-baseline gap-1.5 px-2 pt-1.5 pb-1">
            <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: theme.sub }}>Model</span>
            <span className="text-[11px]" style={{ color: theme.sub, opacity: 0.7 }}>strongest first</span>
            {speed && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); speed.onTest(); }}
                disabled={speed.testing}
                className="ml-auto text-[11px] font-semibold rounded-md px-2 py-0.5 inline-flex items-center gap-1"
                style={{ color: theme.accent, background: `${theme.accent}18`, opacity: speed.testing ? 0.7 : 1 }}
                title="Times every model on a real spoken request ('What do I have tomorrow?') against your calendar. Nothing is changed."
              >
                {speed.testing ? <Loader2 size={11} className="animate-spin" /> : <Gauge size={11} />}
                {speed.testing ? 'Testing all models...' : speed.speeds.testedAt ? 'Test again' : 'Test speed'}
              </button>
            )}
          </div>
          {speed && (
            <div className="px-2 pb-1.5 text-[10.5px] leading-snug" style={{ color: speed.error ? '#ef4444' : theme.sub }}>
              {speed.error
                ? speed.error
                : speed.speeds.testedAt
                  ? `Seconds until each model starts talking (${speed.mode === 'thinking' ? 'thinking first' : 'without thinking first'}), measured ${ago(speed.speeds.testedAt)} on a real request.`
                  : speed.testing ? 'Timing each model, with and without thinking, on a real request. About four minutes.' : 'Not measured yet.'}
            </div>
          )}

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

          {favs.length > 0 && (
            <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5 text-[10.5px] uppercase tracking-[0.06em]" style={{ color: STAR }}>
              <Star size={11} fill="currentColor" /> Favorites
              <span className="text-[10px] tracking-normal px-1.5 rounded-md" style={{ background: `${STAR}24` }}>{favs.length}</span>
            </div>
          )}
          {favs.map(row)}
          {favs.length > 0 && rest.length > 0 && (
            <div className="flex items-center gap-2 px-2 pt-2 pb-1 text-[10.5px] uppercase tracking-[0.06em]" style={{ color: theme.sub }}>
              <span className="h-px w-1.5" style={{ background: theme.bdr }} />
              All other models
              <span className="h-px flex-1" style={{ background: theme.bdr }} />
            </div>
          )}
          {rest.map(row)}

          <div className="text-[10.5px] px-2.5 pt-1.5 pb-1 mt-1" style={{ color: theme.sub, borderTop: `1px solid ${theme.bdr}` }}>
            {favs.length === 0 && (
              <span style={{ color: theme.text, opacity: 0.75 }}><Star size={10} className="inline -mt-px" /> Star a model to keep it at the top. </span>
            )}
            Ollama prices from ollama.com/pricing; your plan's monthly credits are used first.{' '}
            <span style={{ color: FREE_GREEN }}>OpenRouter free models</span> need an OpenRouter key (Settings, Assistant) and allow 50 requests a day.{' '}
            Your pick, its thinking and your favorites are remembered on this device only.
          </div>
        </div>
      )}
    </div>
  );

  function row(m: ModelInfo) {
    const sel = m.id === model;
    const fav = favSet.has(m.id);
    return (
      <button
        key={m.id}
        type="button"
        data-model={m.id}
        data-sel={sel || undefined}
        onClick={(e) => { e.stopPropagation(); onPick(m.id); setOpen(false); }}
        className={`mp-row w-full text-left rounded-lg px-2.5 py-2 flex flex-col gap-0.5 transition-colors ${moved === m.id ? 'mp-moved' : ''}`}
        style={{ background: sel ? `${theme.accent}1f` : 'transparent' }}
        onMouseEnter={e => { if (!sel) e.currentTarget.style.background = theme.hover; }}
        onMouseLeave={e => { if (!sel) e.currentTarget.style.background = 'transparent'; }}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold" style={{ color: theme.text }}>{m.name}</span>
          {m.provider === 'openrouter'
            ? <span className="text-[10px] px-1.5 py-px rounded-md tracking-[0.02em]" style={{ color: OPENROUTER, background: `${OPENROUTER}26` }} title="Runs on OpenRouter">OpenRouter</span>
            : <span className="text-[10px] px-1.5 py-px rounded-md tracking-[0.02em]" style={{ color: theme.sub, background: theme.hover }} title="Runs on Ollama Cloud">Ollama</span>}
          {m.vision && (
            <span className="text-[10.5px] px-1.5 py-px rounded-md inline-flex items-center gap-1" style={{ color: VISION, background: `${VISION}24` }} title="Can see images">
              <ImageIcon size={11} /> vision
            </span>
          )}
          {speed && m.provider === 'openrouter' && (
            <span className="ml-auto text-[10.5px]" style={{ color: theme.sub }} title="The speed test skips OpenRouter's free models: it would spend their 50 requests a day.">not timed</span>
          )}
          {speed && m.provider === 'ollama' && <SpeedBadge s={speed.speeds[speed.mode]?.[m.id]} other={speed.speeds[speed.mode === 'quick' ? 'thinking' : 'quick']?.[m.id]} mode={speed.mode} testing={speed.testing} theme={theme} />}
          {sel && <Check size={13} className={`${speed ? '' : 'ml-auto '}flex-shrink-0`} style={{ color: theme.accent }} />}
          <span
            role="button"
            tabIndex={0}
            aria-pressed={fav}
            className={`mp-star ${fav ? 'on' : ''} ${sel || speed ? 'ml-0.5' : 'ml-auto'} -mr-1 w-[22px] h-[22px] flex-shrink-0 rounded-md inline-flex items-center justify-center`}
            title={fav ? 'Remove from favorites' : 'Add to favorites (keeps it at the top)'}
            onClick={(e) => { e.stopPropagation(); toggleFav(m.id); }}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' && e.key !== ' ') return;
              e.preventDefault(); e.stopPropagation(); toggleFav(m.id);
            }}
          >
            <Star size={14} fill={fav ? 'currentColor' : 'none'} />
          </span>
        </div>
        <div className="flex flex-wrap gap-x-2.5 text-[11.5px] tabular-nums" style={{ color: theme.sub }}>
          <span>{paramsLabel(m)}</span>
          {m.experts && <span title={expertsTitle(m.experts)}>{expertsLabel(m.experts)}</span>}
          <span>{fmtCtx(m.context)} context</span>
          <span>{fmtDate(m.released)}</span>
        </div>
        <ThinkTag
          spec={m.think}
          provider={PROVIDER_LABEL[m.provider]}
          // The chat's menu: a level pill picks the model and its thinking in one click.
          current={chat ? think.settingOf(m.id).level : undefined}
          onPick={chat ? (l => { think.setThink(m.id, { level: l, budget: 0 }); onPick(m.id); setOpen(false); }) : undefined}
        />
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
  }
}
