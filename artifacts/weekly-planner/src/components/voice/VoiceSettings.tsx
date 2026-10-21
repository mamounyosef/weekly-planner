// Settings > Voice Assistant: which voice speaks, how fast, how long a pause
// ends your turn, whether you can talk over it, and which model answers in
// voice mode (with how fast each one starts talking, measured on this PC).
// Everything here belongs to this device, like the chat's model pick.

import React, { useEffect, useMemo, useState } from 'react';
import { AudioLines, Check, Cpu, Gauge, Loader2, Pause, Play, RefreshCw } from 'lucide-react';

import { MODELS, paramsLabel } from '@/lib/agent/agentModels';
import { VOICE_MODEL_KEY, useModelSpeeds, type ModelSpeed } from '@/lib/agent/agentClient';
import { isKnownModel, DEFAULT_MODEL } from '@/lib/agent/agentModels';
import { useVoicePrefs } from '@/lib/voice/voicePrefs';
import { fetchVoiceStatus, fetchVoices, previewVoice, type VoiceInfo } from '@/lib/voice/voiceSession';
import type { PauseLength } from '@/lib/voice/speechText';

export interface VoiceSettingsTheme {
  darkMode: boolean;
  text: string;
  sub: string;
  card: string;
  bdr: string;
  accent: string;
  accentLight: string;
}

const PAUSES: Array<{ id: PauseLength; label: string; desc: string }> = [
  { id: 'quick', label: 'Quick', desc: 'Answers half a second after you stop. Snappy, may cut in.' },
  { id: 'balanced', label: 'Balanced', desc: 'Three quarters of a second. Right for most people.' },
  { id: 'patient', label: 'Patient', desc: 'Over a second. For thinking out loud.' },
];

function readVoiceModel(): string {
  try {
    const v = localStorage.getItem(VOICE_MODEL_KEY) ?? localStorage.getItem('planner-agent-model');
    return isKnownModel(v) ? v : DEFAULT_MODEL;
  } catch { return DEFAULT_MODEL; }
}

const fmtSec = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;

export default function VoiceSettings({ theme: t }: { theme: VoiceSettingsTheme }) {
  const [prefs, update] = useVoicePrefs();
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [voicesError, setVoicesError] = useState<string | null>(null);
  const [status, setStatus] = useState<Awaited<ReturnType<typeof fetchVoiceStatus>> | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [model, setModelState] = useState(readVoiceModel);
  const speeds = useModelSpeeds(true, false);

  useEffect(() => {
    fetchVoiceStatus().then(setStatus).catch(() => setStatus(null));
    fetchVoices().then(v => { setVoices(v); setVoicesError(null); }).catch(e => setVoicesError(e?.message ?? 'Could not load the voices.'));
  }, []);
  useEffect(() => {
    if (!status || status.ready) return;
    const id = setInterval(() => fetchVoiceStatus().then(setStatus).catch(() => {}), 2500);
    return () => clearInterval(id);
  }, [status]);

  const setModel = (id: string) => {
    try { localStorage.setItem(VOICE_MODEL_KEY, id); } catch { /* private mode */ }
    setModelState(id);
  };

  const play = async (id: string) => {
    if (playing) return;
    setPlaying(id);
    try {
      const v = voices.find(x => x.id === id);
      await previewVoice(id, prefs.speed, prefs.volume, v ? `Hi, I'm ${v.name}. Your gym session is moved to Thursday at 6 PM, and you're free after that.` : undefined);
    } catch (e: any) {
      setVoicesError(e?.message ?? 'Could not play that voice.');
    } finally {
      setPlaying(null);
      fetchVoiceStatus().then(setStatus).catch(() => {});
    }
  };

  const groups = useMemo(() => {
    const out: Array<{ title: string; items: VoiceInfo[] }> = [];
    for (const accent of ['American', 'British']) {
      for (const gender of ['female', 'male']) {
        const items = voices.filter(v => v.accent === accent && v.gender === gender);
        if (items.length) out.push({ title: `${accent} ${gender === 'female' ? 'women' : 'men'}`, items });
      }
    }
    return out;
  }, [voices]);

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
      {card(<>
        {heading(<AudioLines size={18} style={{ color: t.accent }} />, 'Voice mode',
          'Talk with the assistant out loud. Start it from the assistant (the waveform button), or middle-click the floating orb. Hearing and speaking run on this PC\'s graphics card, free, and nothing you say leaves the PC except the words sent to the model.')}
        <div className="flex items-center gap-3 text-xs rounded-2xl px-3 py-2.5" style={{ background: t.accentLight, color: t.text }}>
          <Cpu size={15} style={{ color: t.accent }} />
          {status === null ? 'Checking the speech engine...'
            : !status.available ? 'The speech engine is not installed on this PC.'
              : status.ready ? `Speech engine ready on the ${status.device === 'cuda' ? 'GPU' : 'CPU'}.`
                : status.loading ? 'Loading the voice models...'
                  : status.running ? 'Speech engine running; models load on first use (a few seconds).'
                    : 'Speech engine asleep; it starts when you use voice mode.'}
          {status?.error && <span style={{ color: '#ef4444' }}>{status.error}</span>}
        </div>
      </>)}

      {card(<>
        {heading(<Play size={18} style={{ color: t.accent }} />, 'Voice', 'Who you hear. Press play to listen to each one.')}
        {voicesError && <div className="text-xs" style={{ color: '#ef4444' }}>{voicesError}</div>}
        {!voices.length && !voicesError && <div className="text-xs flex items-center gap-2" style={{ color: t.sub }}><Loader2 size={13} className="animate-spin" /> Loading voices (starting the speech engine)...</div>}
        {groups.map(g => (
          <div key={g.title} className="flex flex-col gap-2">
            <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: t.sub }}>{g.title}</div>
            <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {g.items.map(v => {
                const sel = prefs.voice === v.id;
                return (
                  <div
                    key={v.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => update({ voice: v.id })}
                    onKeyDown={e => { if (e.key === 'Enter') update({ voice: v.id }); }}
                    className="rounded-2xl px-3 py-2.5 flex items-center gap-2.5 cursor-pointer transition-colors"
                    style={{
                      border: `1px solid ${sel ? t.accent : t.bdr}`,
                      background: sel ? t.accentLight : 'transparent',
                    }}
                  >
                    <button
                      type="button"
                      onClick={e => { e.stopPropagation(); void play(v.id); }}
                      disabled={!!playing && playing !== v.id}
                      title={`Listen to ${v.name}`}
                      className="w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center text-white"
                      style={{ background: v.gender === 'female' ? 'linear-gradient(135deg,#fb923c,#f43f5e)' : 'linear-gradient(135deg,#38bdf8,#6366f1)', opacity: playing && playing !== v.id ? 0.4 : 1 }}
                    >
                      {playing === v.id ? <Pause size={13} fill="currentColor" /> : <Play size={13} fill="currentColor" className="ml-0.5" />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-semibold flex items-center gap-1" style={{ color: t.text }}>
                        {v.name}
                        {v.id === 'af_heart' && <span className="text-[9px] font-bold px-1.5 py-px rounded-full" style={{ background: 'rgba(16,185,129,0.15)', color: '#10b981' }}>BEST</span>}
                      </div>
                      <div className="text-[11px] truncate" style={{ color: t.sub }}>{v.note}</div>
                    </div>
                    {sel && <Check size={15} style={{ color: t.accent }} className="flex-shrink-0" />}
                  </div>
                );
              })}
            </div>
          </div>
        ))}

        <div className="grid gap-4 sm:grid-cols-2 pt-1">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold flex justify-between" style={{ color: t.text }}>Speaking speed <span className="tabular-nums" style={{ color: t.sub }}>{prefs.speed.toFixed(2)}x</span></span>
            <input type="range" min={0.8} max={1.3} step={0.05} value={prefs.speed} onChange={e => update({ speed: Number(e.target.value) })} />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold flex justify-between" style={{ color: t.text }}>Volume <span className="tabular-nums" style={{ color: t.sub }}>{Math.round(prefs.volume * 100)}%</span></span>
            <input type="range" min={0.1} max={1} step={0.05} value={prefs.volume} onChange={e => update({ volume: Number(e.target.value) })} />
          </label>
        </div>
      </>)}

      {card(<>
        {heading(<Pause size={18} style={{ color: t.accent }} />, 'Conversation', 'How it takes turns with you.')}
        <div className="flex flex-col gap-2">
          <span className="text-xs font-semibold" style={{ color: t.text }}>Pause before it answers</span>
          <div className="grid grid-cols-3 gap-2">
            {PAUSES.map(p => {
              const sel = prefs.pause === p.id;
              return (
                <button key={p.id} type="button" onClick={() => update({ pause: p.id })}
                  className="rounded-2xl px-3 py-2.5 text-left transition-colors"
                  style={{ border: `1px solid ${sel ? t.accent : t.bdr}`, background: sel ? t.accentLight : 'transparent' }}>
                  <div className="text-[13px] font-semibold" style={{ color: sel ? t.accent : t.text }}>{p.label}</div>
                  <div className="text-[11px] leading-snug" style={{ color: t.sub }}>{p.desc}</div>
                </button>
              );
            })}
          </div>
          <span className="text-[11px]" style={{ color: t.sub }}>
            When you trail off on "and", "um" or "so", it waits longer on its own.
          </span>
        </div>
        <Toggle t={t} on={prefs.interrupt} onChange={v => update({ interrupt: v })}
          title="Let me talk over it" desc="Start talking while it speaks and it stops to listen. A quick 'mm-hm' does not stop it. Turn off if your speakers echo into the mic." />
        <Toggle t={t} on={prefs.sounds} onChange={v => update({ sounds: v })}
          title="Soft sounds" desc="A gentle tone when voice mode starts, when it has heard you, and when it ends." />
      </>)}

      {card(<>
        <div className="flex items-start gap-2">
          <div className="flex-1">
            {heading(<Gauge size={18} style={{ color: t.accent }} />, 'Voice model',
              'Which model answers in voice mode. Separate from the chat\'s model, and remembered on this device. The seconds are how long each one took to start talking on a real request ("What do I have tomorrow?") against your calendar, measured on this PC. Nothing is changed by the test.')}
          </div>
          <button type="button" onClick={speeds.test} disabled={speeds.testing}
            className="flex-shrink-0 text-xs font-semibold rounded-xl px-3 py-2 inline-flex items-center gap-1.5"
            style={{ background: t.accentLight, color: t.accent, opacity: speeds.testing ? 0.7 : 1 }}>
            {speeds.testing ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
            {speeds.testing ? 'Testing...' : speeds.speeds.testedAt ? 'Test again' : 'Test speed'}
          </button>
        </div>
        {speeds.error && <div className="text-xs" style={{ color: '#ef4444' }}>{speeds.error}</div>}
        <Toggle t={t} on={prefs.think} onChange={v => update({ think: v })}
          title="Think before answering"
          desc="More careful answers, but a much longer silence before it speaks. Both times are shown below; the highlighted one is what you will get." />
        <div className="flex items-center gap-3 px-3 text-[10px] font-bold uppercase tracking-wider" style={{ color: t.sub }}>
          <span className="flex-1">Model</span>
          <span className="w-[86px] text-right" style={{ opacity: prefs.think ? 0.55 : 1 }}>No thinking</span>
          <span className="w-[86px] text-right" style={{ opacity: prefs.think ? 1 : 0.55 }}>Thinking</span>
          <span className="w-[15px]" />
        </div>
        <div className="flex flex-col gap-1.5">
          {MODELS.map(m => {
            const sel = m.id === model;
            return (
              <button key={m.id} type="button" onClick={() => setModel(m.id)}
                className="rounded-2xl px-3 py-2.5 flex items-center gap-3 text-left transition-colors"
                style={{ border: `1px solid ${sel ? t.accent : t.bdr}`, background: sel ? t.accentLight : 'transparent' }}>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-semibold" style={{ color: t.text }}>{m.name}</div>
                  <div className="text-[11px]" style={{ color: t.sub }}>{paramsLabel(m)}{m.note ? ` · ${m.note}` : ''}</div>
                </div>
                <SpeedCell t={t} s={speeds.speeds.quick?.[m.id]} testing={speeds.testing} active={!prefs.think} />
                <SpeedCell t={t} s={speeds.speeds.thinking?.[m.id]} testing={speeds.testing} active={prefs.think} />
                <span className="w-[15px] flex-shrink-0">{sel && <Check size={15} style={{ color: t.accent }} />}</span>
              </button>
            );
          })}
        </div>
        <div className="text-[11px] leading-snug" style={{ color: t.sub }}>
          <span style={{ color: '#d97706', fontWeight: 700 }}>!</span> means that model answered the test question without looking at your calendar, so its answer was a guess.
          Times vary with how busy Ollama Cloud is; test again any time.
        </div>
      </>)}
    </div>
  );
}

function SpeedCell({ t, s, testing, active }: { t: VoiceSettingsTheme; s?: ModelSpeed; testing: boolean; active: boolean }) {
  const ms = s && !s.error ? s.firstWordMs : null;
  const color = ms === null ? t.sub : ms < 2500 ? '#10b981' : ms < 5000 ? '#d97706' : '#ef4444';
  return (
    <div className="w-[86px] text-right flex-shrink-0" style={{ opacity: active ? 1 : 0.5 }}>
      {testing && !s ? (
        <span className="text-[11px] inline-flex items-center gap-1" style={{ color: t.sub }}><Loader2 size={11} className="animate-spin" /> timing</span>
      ) : s?.error ? (
        <span className="text-[11px]" style={{ color: '#d97706' }} title={s.error}>no answer</span>
      ) : ms !== null ? (
        <>
          <div className="text-[13px] font-bold tabular-nums" style={{ color }} title={s?.usedTools === false ? 'Answered without looking at your calendar' : undefined}>
            {s?.usedTools === false && <span style={{ color: '#d97706' }}>! </span>}{fmtSec(ms)}
          </div>
          <div className="text-[10px] tabular-nums" style={{ color: t.sub }}>{s?.replyMs ? `${fmtSec(s.replyMs)} total` : 'first word'}</div>
        </>
      ) : (
        <span className="text-[11px]" style={{ color: t.sub }}>not tested</span>
      )}
    </div>
  );
}

function Toggle({ t, on, onChange, title, desc }: { t: VoiceSettingsTheme; on: boolean; onChange: (v: boolean) => void; title: string; desc: string }) {
  return (
    <button type="button" onClick={() => onChange(!on)} className="flex items-start gap-3 text-left">
      <span className="mt-0.5 w-9 h-5 rounded-full relative flex-shrink-0 transition-colors" style={{ background: on ? t.accent : (t.darkMode ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)') }}>
        <span className="absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all" style={{ left: on ? 18 : 2 }} />
      </span>
      <span>
        <span className="block text-xs font-semibold" style={{ color: t.text }}>{title}</span>
        <span className="block text-[11px] leading-snug" style={{ color: t.sub }}>{desc}</span>
      </span>
    </button>
  );
}
