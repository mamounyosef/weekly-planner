// ─── Voice mode: the shapes both devices share ──────────────────────────────
//
// Pure, no imports beyond types. Edited and tested here, then COPIED to
// mobile/src/lib/voice/ (with speechText.ts and useVoiceConversation.ts), the
// same way the sync engine is shared: the PC and the phone must run the same
// conversation logic. Each device brings its own audio engine (VoiceEngine):
// Web Audio in the browser (voiceSession.ts), react-native-audio-api on the
// phone (phoneVoiceSession.ts).

import type { PauseLength } from './speechText';

export type VoicePhase = 'connecting' | 'loading' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'error' | 'ended';

export interface VoiceSessionConfig {
  voice: string;
  speed: number;
  endpointMs: number;
  hints?: string;
  /** May the user's voice cut the assistant off? */
  interrupt: boolean;
  volume: number;
  sounds: boolean;
  /** Read the saved voice and speed fresh, for each sentence. */
  livePrefs?: () => { voice: string; speed: number };
}

export interface VoiceSessionHandlers {
  onPhase?: (phase: VoicePhase) => void;
  onSpeechStart?: (utt: number, whilePlaying: boolean) => void;
  onPartial?: (text: string, utt: number) => void;
  onFinal?: (text: string, utt: number) => void;
  onDiscard?: (utt: number) => void;
  /** A sentence began playing (for captions). */
  onSaying?: (id: number, text: string) => void;
  /** Everything queued has been said. */
  onQuiet?: () => void;
  onError?: (message: string) => void;
}

/** What a device's audio engine must do for useVoiceConversation. */
export interface VoiceEngine {
  start(): Promise<void>;
  stop(): void;
  /** Queue a sentence; returns its id. */
  say(text: string): number;
  /** Stop talking now and drop everything queued. */
  cancelSpeech(): void;
  /** Lower the voice while the user may be starting to talk. */
  duck(on: boolean): void;
  isPlaying(): boolean;
  setThinking(on: boolean): void;
  setMuted(on: boolean): void;
  /** End the user's turn now instead of waiting for the pause. */
  finishTurn(): void;
  configure(patch: Partial<VoiceSessionConfig>): void;
  /** 0..1 loudness of the mic and of the voice. */
  levels(): { mic: number; out: number };
}

/** Everything device-specific the conversation needs. */
export interface VoiceEnv {
  createSession: (cfg: VoiceSessionConfig, handlers: VoiceSessionHandlers) => VoiceEngine;
  /** This device's saved choices, read fresh. */
  readPrefs: () => VoicePrefs;
  /** The planner's own words, so speech recognition spells them right. */
  fetchHints: () => Promise<string>;
  /** Turns a start failure into words for the user. */
  describeStartError?: (err: unknown) => string;
}

// ─── This device's choices ──────────────────────────────────────────────────

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
