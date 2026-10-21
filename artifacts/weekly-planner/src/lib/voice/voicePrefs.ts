// ─── Voice mode: this device's choices (browser) ────────────────────────────
//
// Kept per device (localStorage), like the assistant's model pick: the PC's
// two windows share one profile and so one set, the phone has its own. The
// shapes and their validation are shared with the phone (voiceTypes.ts). The
// voice model itself lives beside the chat model in agentClient
// (VOICE_MODEL_KEY), so the model menu can stay one component.

import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_VOICE_PREFS, coerceVoicePrefs, type VoicePrefs } from './voiceTypes';

export { DEFAULT_VOICE_PREFS, coerceVoicePrefs, type VoicePrefs };

const KEY = 'planner-voice-prefs';

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
