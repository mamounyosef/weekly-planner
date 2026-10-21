// The speech engine's on-switch, for the toolbar: shown only while the engine
// is running (models on the graphics card), with how much GPU memory it holds,
// and a click turns it off. Meant for "I'm about to game": the engine exits and
// frees everything, and the next voice session starts it again.

import { useCallback, useEffect, useState } from 'react';
import { Loader2, Power } from 'lucide-react';

import { fetchVoiceStatus, turnOffVoiceEngine, type VoiceEngineStatus } from '@/lib/voice/voiceSession';

const POLL_MS = 10_000;

export function formatVram(mb: number | null | undefined): string {
  if (typeof mb !== 'number' || !Number.isFinite(mb)) return '';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

/** The engine's state, polled while the window is visible. */
export function useVoiceEngineStatus(pollMs = POLL_MS): [VoiceEngineStatus | null, () => void] {
  const [status, setStatus] = useState<VoiceEngineStatus | null>(null);
  const refresh = useCallback(() => {
    fetchVoiceStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    refresh();
    const id = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, pollMs);
    document.addEventListener('visibilitychange', refresh);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', refresh); };
  }, [pollMs, refresh]);
  return [status, refresh];
}

export default function VoiceEngineChip({ surfaceBg, surfaceBdr, menuText }: { surfaceBg: string; surfaceBdr: string; menuText: string }) {
  const [status, refresh] = useVoiceEngineStatus();
  const [busy, setBusy] = useState(false);
  if (!status?.running) return null;

  const what = status.loading ? 'Loading' : status.ready ? (status.device === 'cuda' ? 'GPU' : 'CPU') : 'Idle';
  const mem = formatVram(status.vramMb);
  const off = async () => {
    setBusy(true);
    try { await turnOffVoiceEngine(); } catch { /* it is going away either way */ }
    setTimeout(() => { refresh(); setBusy(false); }, 900);
  };

  return (
    <button
      onClick={off}
      disabled={busy}
      title={`Voice engine is on${mem ? `, using ${mem} of graphics memory` : ''}${status.ready ? '' : ' (models not loaded yet)'}. Click to turn it off and free the GPU; voice mode starts it again.`}
      className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-semibold transition-colors shadow-sm"
      style={{ background: surfaceBg, border: `1px solid ${surfaceBdr}`, color: menuText, opacity: busy ? 0.6 : 1 }}
    >
      <span className="relative flex w-2 h-2">
        <span className="absolute inline-flex w-full h-full rounded-full opacity-60 animate-ping" style={{ background: status.ready ? '#22c55e' : '#f59e0b' }} />
        <span className="relative inline-flex w-2 h-2 rounded-full" style={{ background: status.ready ? '#22c55e' : '#f59e0b' }} />
      </span>
      Voice {what}{mem ? ` · ${mem}` : ''}
      {busy ? <Loader2 size={13} className="animate-spin" /> : <Power size={13} />}
    </button>
  );
}
