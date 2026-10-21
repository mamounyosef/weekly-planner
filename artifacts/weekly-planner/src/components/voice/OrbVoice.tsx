// Voice mode from the floating orb: a conversation with no window at all.
//
// Lives inside the (usually hidden) widget page, which keeps running while it
// is cloaked. Middle-clicking the orb toggles it; the orb itself turns into
// the voice orb, drawn natively by planner_voice_orb.py from the phase and
// loudness this component reports about 30 times a second. No text is shown
// here on purpose: it is the quick way to talk. The whole exchange is still
// saved as a voice chat, readable later in the assistant's history.

import { useEffect, useRef } from 'react';

import { useAgent } from '@/lib/agent/agentClient';
import { useVoiceConversation } from '@/lib/voice/useVoiceConversation';
import { useVoicePrefs } from '@/lib/voice/voicePrefs';
import { WEB_VOICE_ENV } from '@/lib/voice/webVoiceEnv';

export interface OrbVoiceCommand { kind: 'toggle' | 'tap' | 'stop'; n: number }

/** Talking again within this long carries on the same chat. */
const RESUME_MS = 10 * 60_000;

function bridge(): any { return (window as any).pywebview?.api; }

export default function OrbVoice({ command }: { command: OrbVoiceCommand | null }) {
  const [prefs] = useVoicePrefs();
  const agent = useAgent(true, { voice: true, think: prefs.think });
  const voice = useVoiceConversation(agent, prefs, WEB_VOICE_ENV);
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const seen = useRef(0);

  useEffect(() => {
    if (!command || command.n === seen.current) return;
    seen.current = command.n;
    const v = voiceRef.current;
    if (command.kind === 'stop') { if (v.active) v.stop(); return; }
    if (command.kind === 'toggle') {
      if (v.active) v.stop(); else void v.start({ resumeWithinMs: RESUME_MS });
      return;
    }
    // A left click on the voice orb: stop it talking, end your turn, or mute.
    if (!v.active) return;
    if (v.phase === 'speaking') v.interrupt();
    else if (v.phase === 'hearing') v.finishTurn();
    else v.setMuted(!v.muted);
  }, [command]);

  // Report to the orb. Timers keep running in the cloaked widget (it never
  // learns it is hidden), and this is the orb's only source of motion.
  useEffect(() => {
    if (!voice.active && voice.phase !== 'error') {
      bridge()?.voice_orb?.(false, 'ended', 0, 0, false);
      return;
    }
    const send = () => {
      const v = voiceRef.current;
      const l = v.levels();
      bridge()?.voice_orb?.(true, v.phase, Math.round(l.mic * 1000) / 1000, Math.round(l.out * 1000) / 1000, v.muted);
    };
    send();
    const id = setInterval(send, 33);
    // An error shows red for a moment, then the orb goes back to normal.
    const end = voice.phase === 'error' ? setTimeout(() => { voiceRef.current.stop(); bridge()?.voice_orb?.(false, 'ended', 0, 0, false); }, 2600) : null;
    return () => { clearInterval(id); if (end) clearTimeout(end); };
  }, [voice.active, voice.phase]);

  useEffect(() => () => { bridge()?.voice_orb?.(false, 'ended', 0, 0, false); }, []);

  return null;
}
