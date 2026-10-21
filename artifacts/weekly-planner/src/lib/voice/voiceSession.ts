// ─── Voice mode: the live audio session (browser side) ──────────────────────
//
// One microphone, one speaker and one WebSocket to the speech engine on the
// PC (through /api/voice/ws). This class knows nothing about the assistant:
// it hears ("the user said X"), it speaks ("say Y"), and it reports what is
// happening so the orb can show it. useVoiceConversation joins it to the chat.
//
//   mic  -> AudioWorklet (16 kHz int16, 32 ms frames, RMS level) -> engine
//   engine -> [uint32 id][int16 24 kHz PCM] -> scheduled AudioBuffers -> duck
//          gain -> volume gain -> analyser (level for the orb) -> speakers
//
// The browser's own echo cancellation is on, so the assistant's voice coming
// out of the speakers is (mostly) removed from what the mic sends; the engine
// also demands a clearer, longer voice before it counts speech while the
// assistant is talking. Interrupting is then: voice heard -> duck at once ->
// real words confirmed -> stop.

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

const WORKLET = `
class PlannerMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0; this.acc = 0; this.cnt = 0;
    this.out = new Int16Array(512); this.n = 0; this.sq = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.cnt++; this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const v = this.acc / this.cnt; this.acc = 0; this.cnt = 0;
        this.sq += v * v;
        this.out[this.n++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        if (this.n === 512) {
          const frame = this.out; this.out = new Int16Array(512);
          this.port.postMessage({ frame, level: Math.sqrt(this.sq / 512) }, [frame.buffer]);
          this.n = 0; this.sq = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('planner-mic', PlannerMic);
`;

const TTS_RATE = 24000;

export class VoiceSession {
  private cfg: VoiceSessionConfig;
  private h: VoiceSessionHandlers;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private duckGain: GainNode | null = null;
  private volGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf = new Float32Array(512);
  private sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private seq = 0;
  private pending = new Map<number, string>(); // id -> text, until its audio has been sent
  private started = new Set<number>();
  /** Bumped by every cancel, so captions of cancelled sentences never show. */
  private sayGen = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private micLevel = 0;
  private reconnects = 0;
  private closedByUs = false;
  private engineReady = false;
  private userSpeaking = false;
  private thinking = false;
  private muted = false;
  private wasPlaying = false;
  private phase: VoicePhase = 'connecting';

  constructor(cfg: VoiceSessionConfig, handlers: VoiceSessionHandlers) {
    this.cfg = { ...cfg };
    this.h = handlers;
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the microphone here.');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    const Ctx = window.AudioContext || (window as any).webkitAudioContext;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') await this.ctx.resume().catch(() => {});
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
    try { await this.ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'planner-mic', { numberOfInputs: 1, numberOfOutputs: 0 });
    this.node.port.onmessage = (e: MessageEvent<{ frame: Int16Array; level: number }>) => {
      this.micLevel = this.micLevel * 0.5 + e.data.level * 0.5;
      if (this.muted || !this.engineReady) return;
      // Not allowed to interrupt: the mic simply is not heard while it talks.
      if (!this.cfg.interrupt && this.isPlaying()) return;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data.frame.buffer);
    };
    src.connect(this.node);

    this.duckGain = this.ctx.createGain();
    this.volGain = this.ctx.createGain();
    this.volGain.gain.value = this.cfg.volume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.duckGain.connect(this.volGain).connect(this.analyser).connect(this.ctx.destination);

    this.connect();
  }

  stop(): void {
    if (this.phase === 'ended') return;
    this.closedByUs = true;
    if (this.cfg.sounds) this.tone('end');
    this.cancelSpeech();
    try { this.ws?.close(); } catch { /* closed */ }
    this.ws = null;
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    try { this.node?.disconnect(); } catch { /* gone */ }
    const ctx = this.ctx;
    // Let the closing tone finish before the speakers go.
    setTimeout(() => { ctx?.close().catch(() => {}); }, 450);
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.setPhase('ended');
  }

  private connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/api/voice/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.engineReady = false;
    this.setPhase('connecting');
    ws.onopen = () => {
      this.reconnects = 0;
      ws.send(JSON.stringify({ type: 'start', voice: this.cfg.voice, speed: this.cfg.speed, endpointMs: this.cfg.endpointMs, hints: this.cfg.hints ?? '' }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') this.onJson(e.data);
      else this.onAudio(e.data as ArrayBuffer);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.engineReady = false;
      if (this.closedByUs || this.phase === 'ended') return;
      if (this.reconnects < 4) {
        this.reconnects++;
        this.setPhase('connecting');
        this.later(() => { if (!this.closedByUs) this.connect(); }, 600 * this.reconnects);
      } else {
        this.fail('Lost the connection to the speech engine on the PC.');
      }
    };
  }

  private fail(message: string) {
    this.h.onError?.(message);
    this.setPhase('error');
  }

  // ── From the engine ──

  private onJson(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    switch (m.type) {
      case 'status':
        if (m.stage === 'loading') this.setPhase('loading');
        if (m.stage === 'ready') {
          const first = !this.engineReady;
          this.engineReady = true;
          this.ws?.send(JSON.stringify({ type: 'mute', on: this.muted }));
          this.refresh();
          if (first && this.cfg.sounds && this.reconnects === 0) this.tone('ready');
        }
        break;
      case 'speech_start':
        this.userSpeaking = true;
        this.h.onSpeechStart?.(m.utt, this.isPlaying());
        this.refresh();
        break;
      case 'partial':
        this.h.onPartial?.(String(m.text ?? ''), m.utt);
        break;
      case 'final':
        this.userSpeaking = false;
        if (this.cfg.sounds) this.tone('heard');
        this.h.onFinal?.(String(m.text ?? ''), m.utt);
        this.refresh();
        break;
      case 'discard':
        this.userSpeaking = false;
        this.h.onDiscard?.(m.utt);
        this.refresh();
        break;
      case 'tts_done':
        this.pending.delete(Number(m.id));
        this.checkQuiet();
        break;
      case 'error':
        this.h.onError?.(String(m.message ?? 'The speech engine reported an error.'));
        break;
    }
  }

  private onAudio(buf: ArrayBuffer) {
    if (!this.ctx || !this.duckGain || buf.byteLength < 6) return;
    const id = new DataView(buf).getUint32(0, true);
    if (!this.pending.has(id)) return; // cancelled meanwhile
    const pcm = new Int16Array(buf, 4, (buf.byteLength - 4) >> 1);
    const ab = this.ctx.createBuffer(1, pcm.length, TTS_RATE);
    const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.duckGain);
    const at = Math.max(this.ctx.currentTime + 0.04, this.nextAt);
    src.start(at);
    this.nextAt = at + ab.duration;
    this.sources.add(src);
    src.onended = () => { this.sources.delete(src); this.checkQuiet(); this.refresh(); };
    if (!this.started.has(id)) {
      this.started.add(id);
      const text = this.pending.get(id) ?? '';
      const gen = this.sayGen;
      // Only if it was not cancelled in the meantime (talked over).
      this.later(() => { if (gen === this.sayGen) this.h.onSaying?.(id, text); }, Math.max(0, (at - this.ctx.currentTime) * 1000));
    }
    this.setPlaying(true);
    // Queued sentences already counted as "playing"; audio arriving is what
    // turns the orb from thinking to speaking.
    this.refresh();
  }

  // ── Speaking ──

  /** Queue a sentence. Returns its id. */
  say(text: string): number {
    const id = ++this.seq;
    const t = text.trim();
    if (!t || !this.ws || this.ws.readyState !== WebSocket.OPEN) return id;
    this.pending.set(id, t);
    // The voice and speed travel with every sentence, so a change made in
    // Settings (any window) is heard from the next sentence on.
    const live = this.cfg.livePrefs?.();
    const voice = live?.voice ?? this.cfg.voice;
    const speed = live?.speed ?? this.cfg.speed;
    this.ws.send(JSON.stringify({ type: 'speak', id, text: t, voice, speed }));
    this.setPlaying(true);
    return id;
  }

  /** Stop talking now and drop everything queued. */
  cancelSpeech(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel' }));
    this.sayGen++;
    this.pending.clear();
    this.started.clear();
    for (const s of this.sources) { try { s.onended = null; s.stop(); } catch { /* done */ } }
    this.sources.clear();
    this.nextAt = 0;
    this.duck(false);
    this.setPlaying(false);
    this.h.onQuiet?.();
  }

  /** Lower the voice while the user may be starting to talk. */
  duck(on: boolean): void {
    if (!this.ctx || !this.duckGain) return;
    const g = this.duckGain.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(on ? 0.12 : 1, this.ctx.currentTime, on ? 0.03 : 0.12);
  }

  isPlaying(): boolean {
    return this.sources.size > 0 || this.pending.size > 0;
  }

  private setPlaying(on: boolean) {
    if (on === this.wasPlaying) return;
    this.wasPlaying = on;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'playing', on }));
    this.refresh();
  }

  private checkQuiet() {
    if (this.isPlaying()) return;
    this.started.clear();
    this.duck(false);
    this.setPlaying(false);
    this.h.onQuiet?.();
  }

  // ── Controls ──

  setThinking(on: boolean): void { this.thinking = on; this.refresh(); }

  setMuted(on: boolean): void {
    this.muted = on;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'mute', on }));
    if (on) this.userSpeaking = false;
    this.refresh();
  }

  get isMuted(): boolean { return this.muted; }

  /** "I'm done": end the user's turn now instead of waiting for the pause. */
  finishTurn(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'flush' }));
  }

  configure(patch: Partial<VoiceSessionConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    if (this.volGain && patch.volume !== undefined && this.ctx) this.volGain.gain.setTargetAtTime(this.cfg.volume, this.ctx.currentTime, 0.05);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'config', voice: this.cfg.voice, speed: this.cfg.speed, endpointMs: this.cfg.endpointMs, hints: this.cfg.hints ?? '' }));
    }
  }

  /** 0..1 loudness of the mic and of the assistant's voice, for the orb. */
  levels(): { mic: number; out: number } {
    let out = 0;
    if (this.analyser && this.sources.size) {
      this.analyser.getFloatTimeDomainData(this.analyserBuf);
      let sq = 0;
      for (let i = 0; i < this.analyserBuf.length; i++) sq += this.analyserBuf[i] * this.analyserBuf[i];
      out = Math.sqrt(sq / this.analyserBuf.length);
    }
    const shape = (x: number) => Math.min(1, Math.pow(Math.max(0, x) * 5, 0.75));
    return { mic: this.muted ? 0 : shape(this.micLevel), out: shape(out * 1.2) };
  }

  get currentPhase(): VoicePhase { return this.phase; }

  private refresh() {
    if (this.phase === 'ended' || this.phase === 'error') return;
    if (!this.engineReady) return;
    const next: VoicePhase = this.sources.size > 0 ? 'speaking'
      : this.userSpeaking ? 'hearing'
        : this.thinking || this.pending.size > 0 ? 'thinking'
          : 'listening';
    this.setPhase(next);
  }

  private setPhase(p: VoicePhase) {
    if (p === this.phase) return;
    this.phase = p;
    this.h.onPhase?.(p);
  }

  private later(fn: () => void, ms: number) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  /** Soft synthesized cues: no files, nothing to download. */
  private tone(kind: 'ready' | 'heard' | 'end') {
    const ctx = this.ctx;
    if (!ctx) return;
    const notes = kind === 'ready' ? [[587.33, 0], [880, 0.11]] : kind === 'end' ? [[880, 0], [587.33, 0.11]] : [[1174.7, 0]];
    const vol = (kind === 'heard' ? 0.035 : 0.06) * this.cfg.volume;
    for (const [f, d] of notes) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = f;
      const t0 = ctx.currentTime + d;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + (kind === 'heard' ? 0.12 : 0.28));
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.3);
    }
  }
}

/** The words that help the engine spell this planner's names right. */
export async function fetchVoiceHints(): Promise<string> {
  try {
    const r = await fetch('/api/voice/hints');
    if (!r.ok) return '';
    return String((await r.json()).hints ?? '');
  } catch { return ''; }
}

export interface VoiceInfo { id: string; name: string; accent: string; gender: string; note: string }

export async function fetchVoices(): Promise<VoiceInfo[]> {
  const r = await fetch('/api/voice/voices');
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'The voices could not be loaded.');
  return Array.isArray(j.voices) ? j.voices : [];
}

export async function fetchVoiceStatus(): Promise<{ available: boolean; running: boolean; ready: boolean; loading: boolean; device: string | null; error: string | null }> {
  const r = await fetch('/api/voice/status');
  return r.json();
}

/** Play one sentence in a voice (Settings). Resolves when it has finished. */
export async function previewVoice(voice: string, speed: number, volume = 0.9, text?: string): Promise<void> {
  const r = await fetch('/api/voice/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ voice, speed, ...(text ? { text } : {}) }),
  });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'The voice could not be played.');
  }
  const url = URL.createObjectURL(await r.blob());
  const audio = new Audio(url);
  audio.volume = volume;
  await new Promise<void>((resolve) => {
    audio.onended = () => resolve();
    audio.onerror = () => resolve();
    audio.play().catch(() => resolve());
  });
  URL.revokeObjectURL(url);
}
