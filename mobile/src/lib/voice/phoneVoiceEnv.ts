// The phone's pieces for useVoiceConversation: react-native-audio-api, SecureStore.

import { agentApi } from '../agent/agentApi';
import type { VoiceEnv } from './voiceTypes';
import { PhoneVoiceSession } from './phoneVoiceSession';
import { readPhoneVoicePrefs } from './phoneVoicePrefs';

export const PHONE_VOICE_ENV: VoiceEnv = {
  createSession: (cfg, handlers) => new PhoneVoiceSession(cfg, handlers),
  readPrefs: readPhoneVoicePrefs,
  fetchHints: () => agentApi<{ hints?: string }>('/api/voice/hints').then(r => String(r.hints ?? '')).catch(() => ''),
  describeStartError: (err: any) => (err?.name === 'NotAllowedError'
    ? 'Voice mode needs the microphone. Allow it for Daily Planner in Android settings.'
    : String(err?.message ?? 'Voice mode could not start.')),
};

export interface PhoneVoiceInfo { id: string; name: string; accent: string; gender: string; note: string }

export function fetchPhoneVoices(): Promise<PhoneVoiceInfo[]> {
  return agentApi<{ voices?: PhoneVoiceInfo[] }>('/api/voice/voices', { timeoutMs: 60_000 }).then(r => r.voices ?? []);
}

/** One sentence in a voice, played on the phone (Settings). Resolves when done. */
export async function previewPhoneVoice(voice: string, speed: number, volume: number, text?: string): Promise<void> {
  const { AudioContext } = await import('react-native-audio-api');
  const { prefs } = await import('../prefs');
  const { joinUrl, SESSION_COOKIE } = await import('../syncTransport');
  const [base, session] = await Promise.all([prefs.getServerUrl(), prefs.getSession()]);
  if (!base) throw new Error('Not connected to the planner.');
  const res = await fetch(joinUrl(base, '/api/voice/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {}) },
    body: JSON.stringify({ voice, speed, ...(text ? { text } : {}) }),
  });
  if (!res.ok) throw new Error(`The planner answered ${res.status}.`);
  const ctx = new AudioContext();
  try {
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(gain);
    await new Promise<void>(resolve => {
      src.onEnded = () => resolve();
      src.start();
      setTimeout(resolve, (buf.duration + 1) * 1000);
    });
  } finally {
    ctx.close().catch(() => {});
  }
}

export interface PhoneModelSpeed { firstWordMs: number | null; replyMs: number | null; steps: number; usedTools?: boolean; error?: string }
export interface PhoneModelSpeeds { testedAt?: number; quick?: Record<string, PhoneModelSpeed>; thinking?: Record<string, PhoneModelSpeed>; running?: boolean }

export function fetchModelSpeeds(): Promise<PhoneModelSpeeds> {
  return agentApi<PhoneModelSpeeds>('/api/agent/speed');
}

/** Runs the speed test on the PC (a few minutes). */
export function runModelSpeedTest(): Promise<PhoneModelSpeeds> {
  return agentApi<PhoneModelSpeeds>('/api/agent/speed', { method: 'POST', body: {}, timeoutMs: 15 * 60_000 });
}
