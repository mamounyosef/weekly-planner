// ─── Voice mode: the user's choices (phone) ─────────────────────────────────
//
// They belong to the USER and are kept on the planner server
// (/api/voice/prefs), so the phone and the PC always use the same voice,
// speed and so on. SecureStore holds this phone's copy, with an in-memory one
// so the conversation can read it synchronously for every sentence. The copy
// is refreshed from the server when the app opens, comes back to the front,
// or a screen that uses it appears, and every change is written through to the
// server. The engine takes the voice and speed from the server itself, so even
// a stale copy here never picks the wrong voice. The shape and its validation
// are shared with the PC (voiceTypes.ts).

import { useCallback, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import * as SecureStore from 'expo-secure-store';

import { agentApi } from '../agent/agentApi';
import { DEFAULT_VOICE_PREFS, coerceVoicePrefs, type VoicePrefs } from './voiceTypes';

const KEY = 'planner.voicePrefs';
/** The phone's voice-mode model pick, beside the chat's 'planner.agentModel'. */
export const VOICE_MODEL_KEY = 'planner.agentVoiceModel';

let cache: VoicePrefs = { ...DEFAULT_VOICE_PREFS };
/** This phone had saved settings of its own before they moved to the server. */
let hadLocal = false;
const listeners = new Set<(p: VoicePrefs) => void>();

function setCache(next: VoicePrefs) {
  cache = next;
  SecureStore.setItemAsync(KEY, JSON.stringify(cache)).catch(() => {});
  listeners.forEach(l => l(cache));
}

const loaded = SecureStore.getItemAsync(KEY)
  .then(raw => { if (raw) { hadLocal = true; cache = coerceVoicePrefs(JSON.parse(raw)); listeners.forEach(l => l(cache)); } })
  .catch(() => { /* first run, or an unreadable value: defaults */ });

let pulling: Promise<void> | null = null;

/** Takes the user's saved settings from the server into this phone's copy. */
export function pullPhoneVoicePrefs(): Promise<void> {
  pulling ??= (async () => {
    await loaded;
    try {
      const r = await agentApi<{ prefs: unknown }>('/api/voice/prefs', { timeoutMs: 10_000 });
      if (r?.prefs) {
        const next = coerceVoicePrefs(r.prefs);
        if (JSON.stringify(next) !== JSON.stringify(cache)) setCache(next);
      } else if (hadLocal) {
        // Nothing saved for this user yet: what this phone chose becomes theirs.
        await agentApi('/api/voice/prefs', { method: 'PUT', body: cache, timeoutMs: 10_000 });
      }
    } catch { /* PC off or signed out: keep this copy */ }
  })().finally(() => { pulling = null; });
  return pulling;
}

void pullPhoneVoicePrefs();
AppState.addEventListener('change', s => { if (s === 'active') void pullPhoneVoicePrefs(); });

export function readPhoneVoicePrefs(): VoicePrefs { return cache; }

export function loadPhoneVoicePrefs(): Promise<VoicePrefs> { return loaded.then(() => cache); }

export function writePhoneVoicePrefs(patch: Partial<VoicePrefs>): VoicePrefs {
  setCache(coerceVoicePrefs({ ...cache, ...patch }));
  // Only what changed, so a setting changed meanwhile on the PC is kept.
  agentApi('/api/voice/prefs', { method: 'PUT', body: patch, timeoutMs: 10_000 }).catch(() => {});
  return cache;
}

export function usePhoneVoicePrefs(): [VoicePrefs, (patch: Partial<VoicePrefs>) => void] {
  const [prefs, setPrefs] = useState<VoicePrefs>(cache);
  useEffect(() => {
    listeners.add(setPrefs);
    loaded.then(() => setPrefs(cache));
    void pullPhoneVoicePrefs();
    return () => { listeners.delete(setPrefs); };
  }, []);
  const update = useCallback((patch: Partial<VoicePrefs>) => { setPrefs(writePhoneVoicePrefs(patch)); }, []);
  return [prefs, update];
}
