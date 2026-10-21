// ─── Voice mode: this phone's choices ───────────────────────────────────────
//
// Per device, like the assistant's model pick: the PC keeps its own. Stored as
// one JSON value in SecureStore (where the model pick lives too), with an
// in-memory copy so the conversation can read it synchronously for every
// sentence it speaks. The shape and its validation are shared with the PC
// (voiceTypes.ts).

import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

import { DEFAULT_VOICE_PREFS, coerceVoicePrefs, type VoicePrefs } from './voiceTypes';

const KEY = 'planner.voicePrefs';
/** The phone's voice-mode model pick, beside the chat's 'planner.agentModel'. */
export const VOICE_MODEL_KEY = 'planner.agentVoiceModel';

let cache: VoicePrefs = { ...DEFAULT_VOICE_PREFS };
const listeners = new Set<(p: VoicePrefs) => void>();

const loaded = SecureStore.getItemAsync(KEY)
  .then(raw => { if (raw) { cache = coerceVoicePrefs(JSON.parse(raw)); listeners.forEach(l => l(cache)); } })
  .catch(() => { /* first run, or an unreadable value: defaults */ });

export function readPhoneVoicePrefs(): VoicePrefs { return cache; }

export function loadPhoneVoicePrefs(): Promise<VoicePrefs> { return loaded.then(() => cache); }

export function writePhoneVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  cache = coerceVoicePrefs({ ...cache, ...patch });
  SecureStore.setItemAsync(KEY, JSON.stringify(cache)).catch(() => {});
  listeners.forEach(l => l(cache));
  return cache;
}

export function usePhoneVoicePrefs(): [VoicePrefs, (patch: Partial<VoicePrefs>) => void] {
  const [prefs, setPrefs] = useState<VoicePrefs>(cache);
  useEffect(() => {
    listeners.add(setPrefs);
    loaded.then(() => setPrefs(cache));
    return () => { listeners.delete(setPrefs); };
  }, []);
  const update = useCallback((patch: Partial<VoicePrefs>) => { setPrefs(writePhoneVoicePrefs(patch)); }, []);
  return [prefs, update];
}
