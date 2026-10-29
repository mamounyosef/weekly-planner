// How hard the model thinks: a chip in the chat box that opens a dial with
// exactly the levels the current model takes on its service, a token budget
// where the service offers one, and a clear "always thinks" state for models
// that cannot switch reasoning off. Remembered per model, on this device.
// The same control, look and wording as the Notes app's assistant.

import React, { useEffect, useRef, useState } from 'react';

import {
  PROVIDER_LABEL, THINK_BUDGETS, THINK_HINT, THINK_LABEL, THINK_SHORT,
  canStopThinking, fmtBudget, modelInfo, thinkDepth, thinkSummary,
  type ThinkLevel, type ThinkSetting, type ThinkSpec,
} from '@/lib/agent/agentModels';
import { useThinkBook } from '@/lib/agent/thinkPrefs';
import type { AgentTheme } from './AgentCards';

/** The Notes app's colour names, filled from the planner's theme. */
export function tkVars(theme: AgentTheme): React.CSSProperties {
  return {
    ['--text' as any]: theme.text,
    ['--text-dim' as any]: theme.sub,
    ['--text-faint' as any]: `color-mix(in srgb, ${theme.sub} 72%, transparent)`,
    ['--accent' as any]: theme.accent,
    ['--bg-1' as any]: theme.bg,
    ['--bg-2' as any]: theme.darkMode ? '#17191d' : '#ffffff',
    ['--bg-3' as any]: theme.hover,
    ['--bg-4' as any]: theme.bdr,
    ['--line' as any]: theme.bdr,
    ['--line-soft' as any]: theme.bdr,
    ['--ag-ring' as any]: theme.accent,
  };
}

export const THINK_CSS = `
.tk-chip, .tk-seg-light, .tk-bars { --tk: var(--text-faint); }
.tk-pop, .mp-think, .tk-chip { --tk-warm: color-mix(in srgb, #d19a66 75%, var(--text)); }
:is(.tk-chip, .tk-seg-light, .tk-bars).d1 { --tk: color-mix(in srgb, var(--accent) 70%, var(--text-dim)); }
:is(.tk-chip, .tk-seg-light, .tk-bars).d2 { --tk: var(--accent); }
:is(.tk-chip, .tk-seg-light, .tk-bars).d3 { --tk: color-mix(in srgb, var(--accent) 60%, #c678dd); }
:is(.tk-chip, .tk-seg-light, .tk-bars).d4 { --tk: color-mix(in srgb, var(--accent) 25%, #c678dd); }
.tk { position: static; }
.tk-bars rect { fill: currentColor; opacity: 0.28; transition: opacity 0.2s, fill 0.2s; }
.tk-bars rect.lit { fill: var(--tk); opacity: 1; }
.tk-chip { display: inline-flex; align-items: center; gap: 5px; height: 32px; padding: 0 9px 0 8px; border-radius: 16px; font-size: 12px; font-weight: 500; color: var(--text-faint); transition: color 0.15s, background 0.15s, box-shadow 0.2s; white-space: nowrap; }
.tk-chip:hover, .tk-chip.open { color: var(--text); background: var(--bg-3); }
.tk-chip:not(.d0) { color: var(--text-dim); }
.tk-chip:not(.d0):hover, .tk-chip:not(.d0).open { color: var(--text); }
.tk-chip.d4 { box-shadow: 0 0 0 1px color-mix(in srgb, var(--tk) 28%, transparent), 0 0 14px -4px var(--tk); }
.tk-chip-lv { font-style: normal; font-size: 10.5px; font-weight: 600; padding: 1px 6px; border-radius: 8px; color: var(--tk); background: color-mix(in srgb, var(--tk) 15%, transparent); font-variant-numeric: tabular-nums; }
.tk-chip.always .tk-bars { filter: drop-shadow(0 0 2px color-mix(in srgb, var(--tk) 60%, transparent)); }
.tk-pop { position: absolute; left: 8px; right: 8px; bottom: calc(100% + 4px); max-width: 380px; background: var(--bg-2); border: 1px solid var(--line); border-radius: 14px; box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4); padding: 10px 12px 8px; z-index: 50; animation: tk-fade 0.14s ease-out; }
@keyframes tk-fade { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
.tk-head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
.tk-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-faint); }
.tk-model { font-size: 12px; color: var(--text); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tk-model em { font-style: normal; font-weight: 400; color: var(--text-faint); }
.tk-always { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; flex: none; font-size: 10.5px; padding: 1px 7px; border-radius: 8px; color: var(--tk-warm); background: color-mix(in srgb, #d19a66 15%, transparent); }
.tk-always i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: tk-pulse 1.8s ease-in-out infinite; }
@keyframes tk-pulse { 50% { opacity: 0.35; transform: scale(0.75); } }
.tk-seg { position: relative; display: grid; grid-template-columns: repeat(var(--n), 1fr); padding: 3px; border-radius: 10px; background: var(--bg-1); box-shadow: inset 0 0 0 1px var(--line-soft); }
.tk-seg-light { position: absolute; top: 3px; bottom: 3px; left: calc(3px + (100% - 6px) * var(--i) / var(--n)); width: calc((100% - 6px) / var(--n)); border-radius: 7px; background: color-mix(in srgb, var(--tk) 16%, var(--bg-3)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tk) 45%, transparent), 0 2px 10px -3px color-mix(in srgb, var(--tk) 55%, transparent); transition: left 0.28s cubic-bezier(.3, 1.3, .5, 1), background 0.2s, box-shadow 0.2s; }
.tk-stop { position: relative; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 6px 2px 5px; border-radius: 7px; font-size: 11px; color: var(--text-faint); transition: color 0.15s; }
.tk-stop:hover { color: var(--text); }
.tk-stop.on { color: var(--text); font-weight: 600; }
.tk-stop:focus-visible { outline: 2px solid var(--ag-ring); outline-offset: -2px; }
.tk-def { position: absolute; bottom: 1px; width: 3px; height: 3px; border-radius: 50%; background: var(--text-faint); }
.tk-seg.compact { min-width: 200px; }
.tk-seg.compact .tk-stop { flex-direction: row; justify-content: center; gap: 4px; padding: 4px 6px; }
.tk-scale { display: flex; align-items: center; gap: 8px; margin: 6px 4px 0; font-size: 10px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.05em; }
.tk-scale-line { flex: 1; height: 2px; border-radius: 1px; background: linear-gradient(90deg, var(--bg-4), var(--accent), #c678dd); opacity: 0.6; }
.tk-desc { display: flex; flex-direction: column; gap: 2px; margin: 10px 2px 2px; font-size: 12px; color: var(--text-dim); line-height: 1.4; }
.tk-desc b { font-size: 12.5px; color: var(--text); }
.tk-budget { margin: 12px 2px 2px; padding-top: 10px; border-top: 1px solid var(--line-soft); }
.tk-budget.off { opacity: 0.45; }
.tk-budget-head { display: flex; justify-content: space-between; font-size: 12px; color: var(--text-dim); margin-bottom: 6px; }
.tk-budget-head b { color: var(--text); font-variant-numeric: tabular-nums; }
.tk-budget input[type='range'] { -webkit-appearance: none; appearance: none; width: 100%; height: 6px; border-radius: 3px; background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 40%, #c678dd) var(--pct), var(--bg-4) var(--pct)); outline: none; cursor: pointer; }
.tk-budget input[type='range']::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 55%, transparent), 0 1px 4px rgba(0, 0, 0, 0.35); transition: transform 0.15s; }
.tk-budget input[type='range']:active::-webkit-slider-thumb { transform: scale(1.15); }
.tk-budget input[type='range']:disabled { cursor: default; }
.tk-ticks { display: flex; justify-content: space-between; margin-top: 4px; font-size: 9.5px; color: var(--text-faint); font-variant-numeric: tabular-nums; }
.tk-note { margin-top: 6px; font-size: 11px; color: var(--text-faint); }
.tk-foot { margin-top: 10px; padding-top: 6px; border-top: 1px solid var(--line-soft); font-size: 10.5px; color: var(--text-faint); }
.tk-seg.muted .tk-seg-light { opacity: 0.35; }
.mp-think { display: flex; flex-wrap: wrap; align-items: center; gap: 3px; margin: 2px 0 1px; font-size: 10.5px; --tk-c: var(--accent); }
.mp-think.always { --tk-c: var(--tk-warm); }
.mp-think-label { color: var(--text-faint); margin-right: 3px; }
.mp-think.always .mp-think-label { color: var(--tk-c); }
.mp-think-lv { display: inline-flex; align-items: center; gap: 3px; padding: 0 5px; height: 16px; border-radius: 5px; color: var(--text-dim); background: var(--bg-3); }
.mp-think-lv .tk-bars { --tk: var(--tk-c); }
.mp-think-lv.def { color: var(--tk-c); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tk-c) 50%, transparent); background: color-mix(in srgb, var(--tk-c) 10%, transparent); }
.mp-think-lv.pick { cursor: pointer; transition: background 0.12s, color 0.12s, transform 0.12s; }
.mp-think-lv.pick:hover { color: var(--text); background: color-mix(in srgb, var(--tk-c) 22%, transparent); transform: translateY(-1px); }
.mp-think-lv.pick:active { transform: translateY(0); }
.mp-think-lv.cur { color: var(--text); background: color-mix(in srgb, var(--tk-c) 30%, transparent); box-shadow: inset 0 0 0 1px var(--tk-c); font-weight: 600; }
.mp-think-lv.budget { color: var(--tk-c); background: color-mix(in srgb, var(--tk-c) 10%, transparent); }
`;

/** Four rising bars, lit up to the level's depth. */
export function ThinkBars({ depth, size = 12 }: { depth: number; size?: number }) {
  return (
    <svg className={`tk-bars d${depth}`} width={size} height={size} viewBox="0 0 12 12" aria-hidden>
      {[0, 1, 2, 3].map(i => (
        <rect key={i} x={0.5 + i * 3} y={8 - i * 2.4} width={2.2} height={3.5 + i * 2.4} rx={0.9} className={i < depth ? 'lit' : ''} />
      ))}
    </svg>
  );
}

const alwaysHint = (provider: string) =>
  `Always thinks on ${provider}: the service does not let this model skip reasoning, so the lightest level is the fastest it goes.`;

/** The segmented dial: one stop per level the model takes, a sliding light behind the pick. */
export function ThinkLevels({ spec, value, onPick, compact, muted }: { spec: ThinkSpec; value: ThinkLevel; onPick(l: ThinkLevel): void; compact?: boolean; muted?: boolean }) {
  const i = Math.max(0, spec.levels.indexOf(value));
  const step = (d: number) => onPick(spec.levels[Math.min(spec.levels.length - 1, Math.max(0, i + d))]);
  return (
    <div
      className={`tk-seg ${compact ? 'compact' : ''} ${muted ? 'muted' : ''}`}
      role="radiogroup"
      aria-label="Thinking level"
      style={{ ['--n' as any]: spec.levels.length, ['--i' as any]: i }}
      onKeyDown={e => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') step(1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') step(-1);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <span className={`tk-seg-light d${thinkDepth(value)}`} />
      {spec.levels.map(l => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={l === value}
          tabIndex={l === value ? 0 : -1}
          className={`tk-stop ${l === value ? 'on' : ''}`}
          title={`${THINK_LABEL[l]}: ${THINK_HINT[l]}${spec.default === l ? ' (the service default)' : ''}`}
          onClick={() => onPick(l)}
        >
          <ThinkBars depth={thinkDepth(l)} size={11} />
          <span>{THINK_SHORT[l]}</span>
          {spec.default === l && !compact && <i className="tk-def" />}
        </button>
      ))}
    </div>
  );
}

/** Reasoning token cap, for models whose service takes one. Auto leaves it to the level. */
function ThinkBudget({ value, disabled, onPick }: { value: number; disabled: boolean; onPick(n: number): void }) {
  const idx = value ? Math.max(1, THINK_BUDGETS.findIndex(b => b >= value) + 1 || THINK_BUDGETS.length) : 0;
  const pct = (idx / THINK_BUDGETS.length) * 100;
  return (
    <div className={`tk-budget ${disabled ? 'off' : ''}`}>
      <div className="tk-budget-head">
        <span>Token budget</span>
        <b>{value ? `${fmtBudget(value)} tokens` : 'Auto'}</b>
      </div>
      <input
        type="range"
        min={0}
        max={THINK_BUDGETS.length}
        step={1}
        value={idx}
        disabled={disabled}
        style={{ ['--pct' as any]: `${pct}%` }}
        aria-label="Reasoning token budget"
        title="How many tokens it may spend reasoning. Auto follows the level. A small budget answers sooner; a large one lets it work through harder problems."
        onChange={e => {
          const n = Number(e.target.value);
          onPick(n ? THINK_BUDGETS[n - 1] : 0);
        }}
      />
      <div className="tk-ticks">
        <span>Auto</span>
        {THINK_BUDGETS.map(b => <span key={b}>{fmtBudget(b)}</span>)}
      </div>
      {value > 0 && !disabled && <div className="tk-note">A budget replaces the level: OpenRouter takes one or the other.</div>}
    </div>
  );
}

/**
 * The model card's line: the levels it takes, the service default marked.
 * With onPick each level is a button: one click picks the model and that level together.
 */
export function ThinkTag({ spec, provider, current, onPick }: { spec: ThinkSpec; provider: string; current?: ThinkLevel; onPick?(l: ThinkLevel): void }) {
  const always = !canStopThinking(spec);
  const title = [
    always ? alwaysHint(provider) : 'Thinking can be switched off.',
    `Levels: ${spec.levels.map(l => THINK_LABEL[l]).join(', ')}.`,
    spec.default ? `Service default: ${THINK_LABEL[spec.default]}.` : 'The service does not state a default.',
    spec.budget ? 'Also takes a reasoning token budget.' : '',
  ].filter(Boolean).join(' ');
  return (
    <div className={`mp-think ${always ? 'always' : ''}`} title={title} aria-label={`Thinking: ${thinkSummary(spec)}`}>
      <span className="mp-think-label">{always ? 'Always thinks' : 'Thinking'}</span>
      {spec.levels.map(l => (
        <span
          key={l}
          className={`mp-think-lv ${spec.default === l ? 'def' : ''} ${current === l ? 'cur' : ''} ${onPick ? 'pick' : ''}`}
          // A span, not a button: the whole card around it is already a button.
          role={onPick ? 'button' : undefined}
          title={onPick ? `Use this model with thinking ${THINK_LABEL[l]}${current === l ? ' (your choice now)' : ''}${spec.default === l ? ' (service default)' : ''}` : undefined}
          onClick={onPick && (e => { e.stopPropagation(); onPick(l); })}
        >
          <ThinkBars depth={thinkDepth(l)} size={9} />
          {THINK_SHORT[l]}
        </span>
      ))}
      {spec.budget && <span className="mp-think-lv budget">token budget</span>}
    </div>
  );
}

/** The chat box chip and its dial. */
export default function ThinkControl({ model, theme, disabled }: { model: string; theme: AgentTheme; disabled?: boolean }) {
  const { book, setThink, settingOf } = useThinkBook();
  const setting = settingOf(model);
  const saved = book[model];
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const m = modelInfo(model);
  const spec = m.think;
  const always = !canStopThinking(spec);
  const provider = PROVIDER_LABEL[m.provider];
  const depth = thinkDepth(setting.level);
  const pick = (s: ThinkSetting) => setThink(model, s);
  // A new level drops the budget; turning thinking off keeps it for when it comes back on.
  const pickLevel = (level: ThinkLevel) => pick({ level, budget: level === 'off' ? saved?.budget : 0 });

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

  // Opening the dial puts the keyboard on the current level.
  useEffect(() => {
    if (open) requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>('.tk-pop .tk-stop.on')?.focus());
  }, [open]);

  const label = setting.budget ? fmtBudget(setting.budget) : setting.level === 'on' || setting.level === 'off' ? '' : THINK_SHORT[setting.level];
  const chipTitle = `Thinking: ${setting.budget ? `up to ${fmtBudget(setting.budget)} tokens` : THINK_LABEL[setting.level]}. ${setting.budget ? '' : THINK_HINT[setting.level]}${always ? ` ${alwaysHint(provider)}` : ''} Click to change, scroll to step.`;

  return (
    <div className="tk" ref={ref} style={tkVars(theme)}>
      <style>{THINK_CSS}</style>
      <button
        type="button"
        disabled={disabled}
        className={`tk-chip d${depth} ${open ? 'open' : ''} ${always ? 'always' : ''}`}
        style={{ opacity: disabled ? 0.5 : 1 }}
        title={chipTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={e => { e.stopPropagation(); setOpen(!open); }}
        onWheel={e => {
          if (open || !e.deltaY) return;
          const i = spec.levels.indexOf(setting.level);
          const next = spec.levels[Math.min(spec.levels.length - 1, Math.max(0, i + (e.deltaY < 0 ? 1 : -1)))];
          if (next !== setting.level) pickLevel(next);
        }}
      >
        <ThinkBars depth={depth} size={12} />
        Think
        {label && <em className="tk-chip-lv">{label}</em>}
      </button>
      {open && (
        <div className="tk-pop" role="dialog" aria-label="Thinking" onKeyDown={e => { if (e.key !== 'Escape') e.stopPropagation(); }}>
          <div className="tk-head">
            <span className="tk-title">Thinking</span>
            <span className="tk-model">{m.name} <em>on {provider}</em></span>
            {always && <span className="tk-always" title={alwaysHint(provider)}><i /> Always thinks</span>}
          </div>
          <ThinkLevels spec={spec} value={setting.level} onPick={pickLevel} muted={Boolean(setting.budget)} />
          <div className="tk-scale">
            <span>Faster</span>
            <span className="tk-scale-line" />
            <span>Deeper</span>
          </div>
          <div className="tk-desc">
            <b>{setting.budget ? `Up to ${fmtBudget(setting.budget)} reasoning tokens` : THINK_LABEL[setting.level]}</b>
            <span>{setting.budget ? 'Reasons until it reaches the budget, then answers.' : THINK_HINT[setting.level]}</span>
          </div>
          {spec.budget && <ThinkBudget value={setting.budget || 0} disabled={setting.level === 'off'} onPick={budget => pick({ level: setting.level, budget })} />}
          <div className="tk-foot">
            Remembered for this model on this device. {spec.default ? `Service default: ${THINK_LABEL[spec.default]}.` : `${provider} does not state a default.`}
          </div>
        </div>
      )}
    </div>
  );
}
