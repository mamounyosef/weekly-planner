// ─── Voice mode: this device's choices ───────────────────────────────────────
//
// Kept per device (localStorage), like the assistant's model pick: the PC's
// two windows share one profile and so one set, the phone has its own. The
// voice model itself lives beside the chat model in agentClient
// (VOICE_MODEL_KEY), so the model menu can stay one component.

import { useCallback, useEffect, useState } from 'react';

import type { PauseLength } from './speechText';

export interface VoicePrefs {
  /** A Kokoro voice id, e.g. "af_heart". */
  voice: string;
  /** 0.8 to 1.3. */
  speed: number;
  /** How long a pause ends your turn. */
  pause: PauseLength;
  /** Talking over the assistant stops it. */
  interrupt: boolean;
  /** Soft tones when voice mode starts, hears you out, and ends. */
  sounds: boolean;
  /** 0 to 1. */
  volume: number;
  /**
   * The model thinks before answering: more careful, but a much longer
   * silence (measured 2 to 9 s to the first word without, 8 to 28 s with).
   */
  think: boolean;
}

export const DEFAULT_VOICE_PREFS: VoicePrefs = {
  voice: 'af_heart',
  speed: 1.0,
  pause: 'balanced',
  interrupt: true,
  sounds: true,
  volume: 0.9,
  think: false,
};

const KEY = 'planner-voice-prefs';

export function coerceVoicePrefs(raw: unknown): VoicePrefs {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  return {
    voice: typeof r.voice === 'string' && /^[a-z]{2}_[a-z]+$/.test(r.voice) ? r.voice : DEFAULT_VOICE_PREFS.voice,
    speed: Math.round(num(r.speed, 0.8, 1.3, DEFAULT_VOICE_PREFS.speed) * 100) / 100,
    pause: r.pause === 'quick' || r.pause === 'patient' || r.pause === 'balanced' ? r.pause : DEFAULT_VOICE_PREFS.pause,
    interrupt: typeof r.interrupt === 'boolean' ? r.interrupt : DEFAULT_VOICE_PREFS.interrupt,
    sounds: typeof r.sounds === 'boolean' ? r.sounds : DEFAULT_VOICE_PREFS.sounds,
    volume: Math.round(num(r.volume, 0, 1, DEFAULT_VOICE_PREFS.volume) * 100) / 100,
    think: typeof r.think === 'boolean' ? r.think : DEFAULT_VOICE_PREFS.think,
  };
}

export function readVoicePrefs(): VoicePrefs {
  try { return coerceVoicePrefs(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return { ...DEFAULT_VOICE_PREFS }; }
}

export function writeVoicePrefs(p: VoicePrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(coerceVoicePrefs(p))); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('planner-voice-prefs'));
}

/** The prefs, live: a change in Settings (or the other window) shows up here. */
export function useVoicePrefs(): [VoicePrefs, (patch: Partial<VoicePrefs>) => void] {
  const [prefs, setPrefs] = useState<VoicePrefs>(readVoicePrefs);
  useEffect(() => {
    const reload = () => setPrefs(readVoicePrefs());
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) reload(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('planner-voice-prefs', reload);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('planner-voice-prefs', reload);
    };
  }, []);
  const update = useCallback((patch: Partial<VoicePrefs>) => {
    const next = coerceVoicePrefs({ ...readVoicePrefs(), ...patch });
    writeVoicePrefs(next);
    setPrefs(next);
  }, []);
  return [prefs, update];
}
