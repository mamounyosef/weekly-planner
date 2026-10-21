// ─── Voice mode: the user's choices (browser) ───────────────────────────────
//
// They belong to the USER and are kept on the planner server
// (/api/voice/prefs), so the PC and the phone always use the same voice,
// speed and so on. localStorage is only this browser's copy: it is what the
// conversation reads synchronously for every sentence, refreshed from the
// server when a window opens or regains focus, and written through to the
// server on every change. The engine takes the voice and speed from the server
// itself, so even a stale copy here can never pick the wrong voice. The shapes
// and their validation are shared with the phone (voiceTypes.ts). The voice
// model stays per device, beside the chat model in agentClient (VOICE_MODEL_KEY).

import { useCallback, useEffect, useState } from 'react';

import { DEFAULT_VOICE_PREFS, coerceVoicePrefs, type VoicePrefs } from './voiceTypes';

export { DEFAULT_VOICE_PREFS, coerceVoicePrefs, type VoicePrefs };

const KEY = 'planner-voice-prefs';

export function readVoicePrefs(): VoicePrefs {
  try { return coerceVoicePrefs(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { return { ...DEFAULT_VOICE_PREFS }; }
}

function storeLocal(p: VoicePrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(coerceVoicePrefs(p))); } catch { /* private mode */ }
  window.dispatchEvent(new CustomEvent('planner-voice-prefs'));
}

function hasLocal(): boolean {
  try { return localStorage.getItem(KEY) !== null; } catch { return false; }
}

async function putServer(patch: Partial<VoicePrefs>): Promise<VoicePrefs | null> {
  try {
    const res = await fetch('/api/voice/prefs', {
      method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.prefs ? coerceVoicePrefs(body.prefs) : null;
  } catch { return null; }
}

let pulling: Promise<void> | null = null;

/** Takes the user's saved settings from the server into this browser's copy. */
export function pullVoicePrefs(): Promise<void> {
  pulling ??= (async () => {
    try {
      const res = await fetch('/api/voice/prefs', { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) return;
      const body = await res.json();
      if (body?.prefs) {
        const next = coerceVoicePrefs(body.prefs);
        if (JSON.stringify(next) !== JSON.stringify(readVoicePrefs())) storeLocal(next);
      } else if (hasLocal()) {
        // Nothing saved for this user yet: what this PC chose before becomes theirs.
        await putServer(readVoicePrefs());
      }
    } catch { /* offline: keep this copy */ }
  })().finally(() => { pulling = null; });
  return pulling;
}

export function writeVoicePrefs(p: VoicePrefs): void {
  const next = coerceVoicePrefs(p);
  storeLocal(next);
  void putServer(next);
}

/** The prefs, live: a change in Settings (or the other window) shows up here. */
export function useVoicePrefs(): [VoicePrefs, (patch: Partial<VoicePrefs>) => void] {
  const [prefs, setPrefs] = useState<VoicePrefs>(readVoicePrefs);
  useEffect(() => {
    const reload = () => setPrefs(readVoicePrefs());
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) reload(); };
    // Another device may have changed them: look again when this window opens
    // or comes back to the front.
    const pull = () => { if (document.visibilityState === 'visible') void pullVoicePrefs(); };
    window.addEventListener('storage', onStorage);
    window.addEventListener('planner-voice-prefs', reload);
    window.addEventListener('focus', pull);
    document.addEventListener('visibilitychange', pull);
    void pullVoicePrefs();
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('planner-voice-prefs', reload);
      window.removeEventListener('focus', pull);
      document.removeEventListener('visibilitychange', pull);
    };
  }, []);
  const update = useCallback((patch: Partial<VoicePrefs>) => {
    const next = coerceVoicePrefs({ ...readVoicePrefs(), ...patch });
    storeLocal(next);
    setPrefs(next);
    // Only what changed, so a setting changed meanwhile on the phone is kept.
    void putServer(patch);
  }, []);
  return [prefs, update];
}
