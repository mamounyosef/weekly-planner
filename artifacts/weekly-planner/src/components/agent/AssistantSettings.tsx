// Settings > Assistant: the API keys of each service (Ollama, OpenRouter),
// the chat's model and its thinking. Keys live on the PC (the planner
// server); this page only ever sees them masked. They are tried in order:
// when one runs out of credit, the next key of the SAME service answers and
// the reply says so. The model and thinking picks belong to this device.

import React, { useCallback, useEffect, useState } from 'react';
import { Brain, KeyRound, Loader2 } from 'lucide-react';

import { agentKeysApi } from '@/lib/agent/agentClient';
import {
  DEFAULT_MODEL, MODELS, PROVIDERS, PROVIDER_LABEL, canStopThinking, fmtCtx, isKnownModel, modelInfo, paramsLabel, type Provider,
} from '@/lib/agent/agentModels';
import type { AgentKeyInfo } from '@/lib/agent/agentTypes';
import { useThinkBook } from '@/lib/agent/thinkPrefs';
import type { VoiceSettingsTheme } from '../voice/VoiceSettings';
import { THINK_CSS, ThinkLevels } from './ThinkControl';

const MODEL_KEY = 'planner-agent-model';
const OK = '#10b981';
const BAD = '#ef4444';

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const HINT: Record<Provider, string> = {
  ollama: 'Create one at ollama.com, Settings, Keys.',
  openrouter: 'For the free OpenRouter models. Create one at openrouter.ai, Keys.',
};

function KeyRows({ t, provider, keys, onChanged }: { t: VoiceSettingsTheme; provider: Provider; keys: AgentKeyInfo[]; onChanged: () => void }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [limits, setLimits] = useState<string[]>([]);
  const label = PROVIDER_LABEL[provider];

  // OpenRouter tells each key's free requests used today.
  const keyCount = keys.length;
  useEffect(() => {
    if (provider !== 'openrouter' || !keyCount) { setLimits([]); return; }
    let gone = false;
    Promise.all(Array.from({ length: keyCount }, (_, i) => agentKeysApi.openrouterLimits(i)
      .then(l => (l.ok && l.freeLimit ? ` Free requests today: ${l.freeUsed ?? 0} of ${l.freeLimit} used.` : ''))))
      .then(v => { if (!gone) setLimits(v); });
    return () => { gone = true; };
  }, [provider, keyCount]);

  const act = async (job: () => Promise<{ ok: boolean; error?: string; info?: string }>, done: (info?: string) => string) => {
    setBusy(true);
    setMsg(null);
    const r = await job();
    setBusy(false);
    setMsg(r.ok ? { text: done(r.info) } : { text: r.error || 'That did not work.', bad: true });
    onChanged();
  };
  const add = () => act(async () => {
    const r = await agentKeysApi.add(provider, key.trim());
    if (r.ok) setKey('');
    return r;
  }, () => `Key saved. It is used when the ${label} keys above it run out.`);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[200px]">
          <div className="text-[13px] font-semibold" style={{ color: t.text }}>{label} API keys</div>
          <div className="text-[11px] leading-snug" style={{ color: t.sub }}>
            {keys.length
              ? `Saved on the PC. Tried in order: when one runs out of credit, the next ${label} key is used, and the reply says so.`
              : `Not set. ${HINT[provider]}`}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="password"
            autoComplete="off"
            placeholder={keys.length ? 'Add another key' : 'Paste key'}
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && key.trim() && !busy) void add(); }}
            className="rounded-xl px-3 py-1.5 text-xs outline-none w-[210px]"
            style={{ border: `1px solid ${t.bdr}`, background: 'transparent', color: t.text }}
          />
          <button
            type="button"
            disabled={!key.trim() || busy}
            onClick={() => void add()}
            className="text-xs font-semibold rounded-xl px-3 py-1.5 inline-flex items-center gap-1.5"
            style={{ background: t.accentLight, color: t.accent, opacity: !key.trim() || busy ? 0.6 : 1 }}
          >
            {busy && <Loader2 size={12} className="animate-spin" />}{busy ? 'Checking...' : 'Add'}
          </button>
        </div>
      </div>
      {keys.map((k, i) => {
        const state = k.inUse ? (k.outUntil ? (k.trouble === 'rejected' ? 'In use, but refused' : 'In use, but out of credit') : 'In use')
          : k.outUntil ? (k.trouble === 'rejected' ? 'Refused' : 'Out of credit') : 'Backup';
        const color = k.outUntil ? BAD : k.inUse ? OK : t.sub;
        return (
          <div key={`${k.masked}-${i}`} className="flex flex-wrap items-center gap-3 rounded-2xl px-3 py-2.5" style={{ border: `1px solid ${k.inUse ? t.accent : t.bdr}` }}>
            <KeyRound size={14} style={{ color }} className="flex-shrink-0" />
            <div className="flex-1 min-w-[180px]">
              <div className="text-[12.5px] font-semibold flex flex-wrap items-center gap-1.5" style={{ color: t.text }}>
                Key {i + 1}: <span className="font-mono text-[11.5px]">{k.masked}</span>
                {k.fromEnv && <span className="text-[9.5px] font-bold px-1.5 py-px rounded-full" style={{ background: t.accentLight, color: t.accent }} title="Read from OLLAMA_API_KEY in the .env file on the PC. Removing it here only takes it off this list; the .env file is never changed.">.env</span>}
                <span className="text-[11px] font-semibold" style={{ color }}>{state}</span>
              </div>
              <div className="text-[11px] leading-snug" style={{ color: t.sub }}>
                {k.outUntil
                  ? `Skipped until ${clock(k.outUntil)}, then tried again. ${k.detail}`
                  : k.inUse ? 'Requests go to this key.' : 'Used if the keys above it run out.'}
                {limits[i] || ''}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              {!k.inUse && (
                <SmallButton t={t} disabled={busy} title="Use this key from now on" onClick={() => act(() => agentKeysApi.use(provider, i), () => `Key ${i + 1} is now in use.`)}>Use</SmallButton>
              )}
              <SmallButton t={t} disabled={busy} title="Ask the service whether this key works now" onClick={() => act(
                async () => { const r = await agentKeysApi.test(provider, i); return r.ok ? r : { ...r, error: `Key ${i + 1}: ${r.error}` }; },
                info => `Key ${i + 1}: ${info || 'Works.'}`,
              )}>Test</SmallButton>
              <SmallButton t={t} disabled={busy} danger title={k.fromEnv ? 'Take it off this list (the .env file is not changed)' : 'Delete this key from the PC'} onClick={() => {
                if (!window.confirm(`Remove ${label} key ${i + 1} (${k.masked})?${k.fromEnv ? ' The .env file is not changed.' : ''}`)) return;
                void act(() => agentKeysApi.remove(provider, i), () => 'Key removed.');
              }}>Remove</SmallButton>
            </div>
          </div>
        );
      })}
      {msg && <div className="text-[11.5px]" style={{ color: msg.bad ? BAD : t.sub }}>{msg.text}</div>}
    </div>
  );
}

function SmallButton({ t, children, onClick, disabled, danger, title }: { t: VoiceSettingsTheme; children: React.ReactNode; onClick: () => void; disabled?: boolean; danger?: boolean; title?: string }) {
  return (
    <button type="button" disabled={disabled} title={title} onClick={onClick}
      className="text-[11.5px] font-semibold rounded-lg px-2.5 py-1"
      style={{ border: `1px solid ${danger ? `${BAD}66` : t.bdr}`, color: danger ? BAD : t.text, opacity: disabled ? 0.6 : 1 }}>
      {children}
    </button>
  );
}

function readModel(): string {
  try { const v = localStorage.getItem(MODEL_KEY); return isKnownModel(v) ? v : DEFAULT_MODEL; } catch { return DEFAULT_MODEL; }
}

export default function AssistantSettings({ theme: t }: { theme: VoiceSettingsTheme }) {
  const [status, setStatus] = useState<Record<Provider, AgentKeyInfo[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModelState] = useState(readModel);
  const think = useThinkBook();

  const refresh = useCallback(() => {
    agentKeysApi.status().then(s => { setStatus(s); setError(null); }).catch(e => setError(e?.message ?? 'Could not load the keys.'));
  }, []);
  useEffect(() => { refresh(); }, [refresh]);
  // The chat's own picker in the other window changes it too.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => { if (e.key === MODEL_KEY) setModelState(readModel()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const setModel = (id: string) => {
    try { localStorage.setItem(MODEL_KEY, id); } catch { /* private mode */ }
    setModelState(id);
  };

  const m = modelInfo(model);
  const card = (children: React.ReactNode) => (
    <div className="p-4 sm:p-6 rounded-3xl border shadow-sm flex flex-col gap-4" style={{ background: t.card, borderColor: t.bdr }}>{children}</div>
  );
  const heading = (icon: React.ReactNode, title: string, desc: string) => (
    <div>
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-bold tracking-tight" style={{ color: t.text }}>{title}</h2>
      </div>
      <p className="text-xs mt-0.5" style={{ color: t.sub }}>{desc}</p>
    </div>
  );

  return (
    <div className="flex flex-col gap-6">
      <style>{THINK_CSS}</style>
      {card(<>
        {heading(<KeyRound size={18} style={{ color: t.accent }} />, 'API keys',
          'The services the assistant runs on. Keys are kept on the PC and never shown again in full. Each service only uses its own keys: a model never moves to the other service.')}
        {error && <div className="text-xs" style={{ color: BAD }}>{error}</div>}
        {!status && !error && <div className="text-xs flex items-center gap-2" style={{ color: t.sub }}><Loader2 size={13} className="animate-spin" /> Loading keys...</div>}
        {status && PROVIDERS.map(p => <KeyRows key={p} t={t} provider={p} keys={status[p]} onChanged={refresh} />)}
      </>)}

      {card(<>
        {heading(<Brain size={18} style={{ color: t.accent }} />, 'Model and thinking',
          'The chat\'s model and how hard it thinks, remembered on this device. Also in the chat box. Voice mode has its own model and switch (Voice Assistant).')}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <div className="text-xs font-semibold" style={{ color: t.text }}>Model</div>
            <div className="text-[11px]" style={{ color: t.sub }}>{paramsLabel(m)}, {fmtCtx(m.context)} context, on {PROVIDER_LABEL[m.provider]}. Default {modelInfo(DEFAULT_MODEL).name}.</div>
          </div>
          <select value={model} onChange={e => setModel(e.target.value)}
            className="rounded-xl px-3 py-1.5 text-xs outline-none w-[230px]"
            style={{ border: `1px solid ${t.bdr}`, background: t.card, color: t.text }}>
            {MODELS.map(x => <option key={x.id} value={x.id}>{x.name} ({PROVIDER_LABEL[x.provider]})</option>)}
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex-1 min-w-[200px]">
            <div className="text-xs font-semibold" style={{ color: t.text }}>Thinking</div>
            <div className="text-[11px]" style={{ color: t.sub }}>
              {canStopThinking(m.think) ? 'Deeper is slower, but better at multi step plans.' : `${m.name} always thinks on ${PROVIDER_LABEL[m.provider]}.`} Kept per model.
            </div>
          </div>
          <div style={{
            ['--text' as any]: t.text, ['--text-dim' as any]: t.sub, ['--text-faint' as any]: `color-mix(in srgb, ${t.sub} 72%, transparent)`,
            ['--accent' as any]: t.accent, ['--bg-1' as any]: 'transparent', ['--bg-3' as any]: t.accentLight, ['--line-soft' as any]: t.bdr, ['--ag-ring' as any]: t.accent,
          }}>
            <ThinkLevels compact spec={m.think} value={think.settingOf(model).level} onPick={level => think.setThink(model, { level })} />
          </div>
        </div>
      </>)}
    </div>
  );
}
