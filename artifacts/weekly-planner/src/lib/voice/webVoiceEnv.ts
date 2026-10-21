// The browser's pieces for useVoiceConversation: Web Audio, localStorage.

import type { VoiceEnv } from './voiceTypes';
import { VoiceSession, fetchVoiceHints } from './voiceSession';
import { readVoicePrefs } from './voicePrefs';

export const WEB_VOICE_ENV: VoiceEnv = {
  createSession: (cfg, handlers) => new VoiceSession(cfg, handlers),
  readPrefs: readVoicePrefs,
  fetchHints: fetchVoiceHints,
  describeStartError: (err: any) => (err?.name === 'NotAllowedError'
    ? 'The microphone is blocked for the planner. Allow it and try again.'
    : err?.name === 'NotFoundError' ? 'No microphone was found.' : (err?.message ?? 'Voice mode could not start.')),
};
