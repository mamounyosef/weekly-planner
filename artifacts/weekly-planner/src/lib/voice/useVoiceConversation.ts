// ─── Voice mode: the conversation ───────────────────────────────────────────
//
// Joins a voice engine (ears and mouth) to the assistant (useAgent with
// { voice: true }). Everything the assistant does still goes through the same
// server run as a typed chat: the same tools, the same verified report, the
// same Approve step for deletes, the same history. Voice only changes how the
// words get in and out:
//
//   heard a sentence    -> sent as a message (a run in progress is stopped
//                          first, so what was just said is never lost)
//   reply streaming in  -> cut into sentences, each spoken the moment it is
//                          complete, so the voice starts while the model is
//                          still writing
//   waiting on a delete -> the list is read out; a spoken yes or no answers
//                          the Approve card ("no" wins when unsure)
//   talked over         -> the voice ducks at once, and stops for good when
//                          real words arrive (a "mm-hm" does not stop it)

import { useCallback, useEffect, useRef, useState } from 'react';

//
// SHARED BY COPYING with mobile/src/lib/voice/ (with voiceTypes.ts and
// speechText.ts): edit here, then copy. Everything device-specific (the audio
// engine, where the prefs live) comes in through `env`.

import type { AgentConversation, AgentConversationSummary, AgentMessage } from '../agent/agentTypes';
import { SentenceSplitter, approvalSpeech, endpointMs, questionSpeech, speakable, yesOrNo } from './speechText';
import type { VoiceEngine, VoiceEnv, VoicePhase, VoicePrefs } from './voiceTypes';

/** What the assistant hook (PC useAgent, phone usePhoneAgent) gives voice mode. */
export interface VoiceAgent {
  conversation: AgentConversation | null;
  liveText: string;
  activeId: string | null;
  list: AgentConversationSummary[];
  send: (text: string, attachmentIds: string[]) => Promise<void>;
  decide: (approved: boolean) => Promise<void>;
  stop: () => Promise<void>;
  select: (id: string | null) => void;
}

export interface VoiceConversation {
  active: boolean;
  phase: VoicePhase;
  muted: boolean;
  /** What the user is saying right now (live), or just said. */
  heard: string;
  heardFinal: boolean;
  /** The sentence the assistant is saying now. */
  saying: string;
  error: string | null;
  start: (opts?: { resumeWithinMs?: number }) => Promise<void>;
  stop: () => void;
  setMuted: (on: boolean) => void;
  /** Stop the assistant talking (a tap on the orb). */
  interrupt: () => void;
  /** End the user's turn now. */
  finishTurn: () => void;
  /** 0..1 loudness, for the orb; cheap enough for every animation frame. */
  levels: () => { mic: number; out: number };
}

/** Short acknowledgements that mean "go on", not "stop". */
const BACKCHANNEL = /^(mm+[- ]?h?mm+|uh[- ]?huh|mhm|yeah|yes|yep|right|okay|ok|sure|got it|i see|cool|nice|great|alright|all right)[.!?, ]*$/i;
const wordCount = (s: string) => s.trim().split(/\s+/).filter(w => /[a-z0-9]/i.test(w)).length;

interface Track {
  msgId: string | null;
  splitter: SentenceSplitter;
  prevLive: string;
  spokeAny: boolean;
  /** Talked over: the rest of this reply is not said. */
  silenced: boolean;
  /** `${state}` already handled for this message. */
  handled: string;
}

const freshTrack = (msgId: string | null): Track => ({ msgId, splitter: new SentenceSplitter(), prevLive: '', spokeAny: false, silenced: false, handled: '' });

function lastAssistant(conv: AgentConversation | null, since: number): AgentMessage | null {
  const msgs = conv?.messages ?? [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === 'user') return null; // the newest turn is the user's: nothing to say yet
    if (m.role === 'assistant') return m.at >= since ? m : null;
  }
  return null;
}

export function useVoiceConversation(agent: VoiceAgent, prefs: VoicePrefs, env: VoiceEnv): VoiceConversation {
  const envRef = useRef(env);
  envRef.current = env;
  const [active, setActive] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>('ended');
  const [muted, setMutedState] = useState(false);
  const [heard, setHeard] = useState('');
  const [heardFinal, setHeardFinal] = useState(false);
  const [saying, setSaying] = useState('');
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<VoiceEngine | null>(null);
  const agentRef = useRef(agent);
  agentRef.current = agent;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const sinceRef = useRef(0);
  const trackRef = useRef<Track>(freshTrack(null));
  const bargeRef = useRef<number | null>(null);
  const interruptedRef = useRef(false);
  const heardTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sendingRef = useRef<Promise<void>>(Promise.resolve());

  const say = useCallback((text: string) => {
    const s = sessionRef.current;
    const t = speakable(text);
    if (!s || !t) return;
    trackRef.current.spokeAny = true;
    s.say(t);
  }, []);

  const silenceReply = useCallback(() => {
    trackRef.current.silenced = true;
    interruptedRef.current = true;
    sessionRef.current?.cancelSpeech();
    setSaying('');
  }, []);

  // ── What was heard becomes a message ──
  const handleFinal = useCallback((text: string) => {
    const s = sessionRef.current;
    if (!s) return;
    const a = agentRef.current;
    const conv = a.conversation;
    const running = conv?.state === 'running';
    const wasBarge = bargeRef.current !== null;
    bargeRef.current = null;
    // "Mm-hm" while it is still answering: keep going.
    if (wasBarge && running && BACKCHANNEL.test(text.trim()) && !trackRef.current.silenced) {
      s.duck(false);
      return;
    }
    if (s.isPlaying()) silenceReply();
    s.setThinking(true);
    const prefix = interruptedRef.current ? '(You were interrupted.) ' : '';
    interruptedRef.current = false;
    // One at a time, in the order they were said.
    sendingRef.current = sendingRef.current.then(async () => {
      try {
        const now = agentRef.current;
        if (now.conversation?.state === 'awaiting_approval') {
          const yn = yesOrNo(text);
          if (yn) { await now.decide(yn === 'yes'); return; }
        }
        if (now.conversation?.state === 'running') {
          await now.stop();
          const until = Date.now() + 8000;
          while (agentRef.current.conversation?.state === 'running' && Date.now() < until) {
            await new Promise(r => setTimeout(r, 120));
          }
        }
        await agentRef.current.send(prefix + text, []);
      } catch (err: any) {
        sessionRef.current?.setThinking(false);
        setError(err?.message ?? 'Could not send that.');
        say('Sorry, I could not send that to the assistant.');
      }
    });
  }, [say, silenceReply]);

  // ── The reply, spoken as it streams ──
  useEffect(() => {
    const s = sessionRef.current;
    if (!active || !s) return;
    const conv = agent.conversation;
    const m = lastAssistant(conv, sinceRef.current);
    if (!m || !conv) return;
    let tr = trackRef.current;
    if (tr.msgId !== m.id) { tr = freshTrack(m.id); trackRef.current = tr; }
    const running = conv.state === 'running';
    const live = running ? agent.liveText : '';
    const speakAll = (parts: string[]) => { if (!tr.silenced) parts.forEach(say); };

    if (live.length < tr.prevLive.length) {
      // One model step ended and the next began: say the last of the previous one.
      speakAll(tr.splitter.finish(tr.prevLive));
      tr.splitter.reset();
    }
    if (live) speakAll(tr.splitter.push(live));
    tr.prevLive = live;

    if (!running && tr.handled !== conv.state) {
      tr.handled = conv.state;
      speakAll(tr.splitter.finish(tr.prevLive));
      tr.prevLive = '';
      tr.splitter.reset();
      // Nothing streamed (a reconnect, a very fast reply): say the saved text.
      if (!tr.spokeAny && !tr.silenced && m.text) speakAll(new SentenceSplitter().finish(m.text));
      if (conv.state === 'awaiting_approval' && m.approval) say(approvalSpeech(m.approval));
      else if (conv.state === 'awaiting_answer' && m.questions?.length) say(questionSpeech(m.questions));
      if (m.error && !/^Stopped\b/.test(m.error)) say(`Sorry. ${m.error.split(/(?<=[.!?])\s/)[0]}`);
      s.setThinking(false);
    }
  }, [active, agent.conversation, agent.liveText, say]);

  // ── Start and stop ──
  const stop = useCallback(() => {
    sessionRef.current?.stop();
    sessionRef.current = null;
    setActive(false);
    setPhase('ended');
    setSaying('');
    setHeard('');
    bargeRef.current = null;
  }, []);

  const start = useCallback(async (opts: { resumeWithinMs?: number } = {}) => {
    if (sessionRef.current) return;
    setError(null);
    setHeard('');
    setSaying('');
    const a = agentRef.current;
    // Carry on the open chat if it is a spoken one; otherwise a fresh voice chat
    // (made on the first sentence), or the latest voice chat if it is recent.
    if (!a.conversation?.voice) {
      const recent = opts.resumeWithinMs
        ? a.list.find(c => c.voice && c.messageCount > 0 && Date.now() - c.updatedAt < opts.resumeWithinMs!)
        : undefined;
      a.select(recent ? recent.id : null);
    }
    sinceRef.current = Date.now();
    trackRef.current = freshTrack(null);
    interruptedRef.current = false;
    const p = envRef.current.readPrefs(); // fresh: Settings may have changed in the other window
    const session = envRef.current.createSession(
      { voice: p.voice, speed: p.speed, endpointMs: endpointMs(p.pause), interrupt: p.interrupt, volume: p.volume, sounds: p.sounds, hints: '', livePrefs: () => { const f = envRef.current.readPrefs(); return { voice: f.voice, speed: f.speed }; } },
      {
        onPhase: setPhase,
        onSpeechStart: (utt, whilePlaying) => {
          setHeard('');
          setHeardFinal(false);
          if (heardTimer.current) clearTimeout(heardTimer.current);
          if (whilePlaying && prefsRef.current.interrupt) {
            bargeRef.current = utt;
            sessionRef.current?.duck(true);
          }
        },
        onPartial: (text, utt) => {
          setHeard(text);
          setHeardFinal(false);
          if (bargeRef.current === utt && wordCount(text) >= 2 && !BACKCHANNEL.test(text.trim())) silenceReply();
        },
        onFinal: (text) => {
          setHeard(text);
          setHeardFinal(true);
          if (heardTimer.current) clearTimeout(heardTimer.current);
          heardTimer.current = setTimeout(() => setHeard(''), 6000);
          handleFinal(text);
        },
        onDiscard: (utt) => {
          if (bargeRef.current === utt) { bargeRef.current = null; sessionRef.current?.duck(false); }
          setHeard('');
        },
        onSaying: (_id, text) => setSaying(text),
        onQuiet: () => setSaying(''),
        onError: (msg) => setError(msg),
      },
    );
    sessionRef.current = session;
    setActive(true);
    setPhase('connecting');
    try {
      await session.start();
      envRef.current.fetchHints().then(hints => { if (hints) session.configure({ hints }); }).catch(() => {});
    } catch (err: any) {
      setError(envRef.current.describeStartError?.(err) ?? err?.message ?? 'Voice mode could not start.');
      session.stop();
      sessionRef.current = null;
      setActive(false);
      setPhase('error');
    }
  }, [handleFinal, silenceReply]);

  // Settings changed while talking: apply at once.
  useEffect(() => {
    sessionRef.current?.configure({
      voice: prefs.voice, speed: prefs.speed, endpointMs: endpointMs(prefs.pause), interrupt: prefs.interrupt, volume: prefs.volume, sounds: prefs.sounds,
    });
  }, [prefs]);

  useEffect(() => () => { sessionRef.current?.stop(); sessionRef.current = null; }, []);

  const setMuted = useCallback((on: boolean) => {
    sessionRef.current?.setMuted(on);
    setMutedState(on);
  }, []);

  const interrupt = useCallback(() => {
    const s = sessionRef.current;
    if (!s) return;
    if (s.isPlaying()) silenceReply();
  }, [silenceReply]);

  const finishTurn = useCallback(() => sessionRef.current?.finishTurn(), []);
  const levels = useCallback(() => sessionRef.current?.levels() ?? { mic: 0, out: 0 }, []);

  return { active, phase, muted, heard, heardFinal, saying, error, start, stop, setMuted, interrupt, finishTurn, levels };
}
