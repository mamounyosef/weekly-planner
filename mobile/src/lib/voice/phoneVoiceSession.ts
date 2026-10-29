// ─── Voice mode: the live audio session on the phone ────────────────────────
//
// The phone's twin of the PC's voiceSession.ts, built on react-native-audio-api
// (a Web Audio implementation for React Native) so it can follow the same
// design almost line for line:
//
//   mic (voice-communication preset: Android's echo cancellation, patched in
//   by scripts/patch-audio-api.mjs) -> 16 kHz int16, 32 ms frames -> the PC's
//   speech engine over /api/voice/ws
//   engine -> [uint32 id][int16 24 kHz PCM] -> scheduled AudioBuffers -> duck
//   gain -> volume gain -> analyser (level for the orb) -> speaker
//
// Hearing and speaking both happen on the PC (Whisper and Kokoro), exactly
// as on the PC itself, so the phone sounds and understands the same. Auth is
// the session cookie, attached by hand like every other phone request.

import {
  AnalyserNode, AudioBufferSourceNode, AudioContext, AudioManager, AudioRecorder, GainNode,
} from 'react-native-audio-api';

import { prefs } from '../prefs';
import { joinUrl, SESSION_COOKIE } from '../syncTransport';
import type { VoiceEngine, VoicePhase, VoiceSessionConfig, VoiceSessionHandlers } from './voiceTypes';

const TTS_RATE = 24000;
const MIC_RATE = 16000;
const FRAME = 512;

/** True while Android's mic permission screen is up (it sends the app to the background). */
let askingPermission = false;
export const isAskingMicPermission = () => askingPermission;

/** One recorder for the app's lifetime: the library prefers a single instance. */
let recorderSingleton: AudioRecorder | null = null;
const recorder = () => (recorderSingleton ??= new AudioRecorder());
/** The last session's recorder stop; a new start waits for it ("already recording" otherwise). */
let recorderStopping: Promise<unknown> = Promise.resolve();

export class PhoneVoiceSession implements VoiceEngine {
  private cfg: VoiceSessionConfig;
  private h: VoiceSessionHandlers;
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private duckGain: GainNode | null = null;
  private volGain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserBuf = new Float32Array(512);
  private sources = new Set<AudioBufferSourceNode>();
  private nextAt = 0;
  private seq = 0;
  private pending = new Map<number, string>();
  private started = new Set<number>();
  private sayGen = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private micLevel = 0;
  private micBuf = new Int16Array(FRAME);
  private micN = 0;
  private micSq = 0;
  private reconnects = 0;
  private closedByUs = false;
  private engineReady = false;
  private userSpeaking = false;
  private thinking = false;
  private muted = false;
  private wasPlaying = false;
  private recording = false;
  private phase: VoicePhase = 'connecting';

  constructor(cfg: VoiceSessionConfig, handlers: VoiceSessionHandlers) {
    this.cfg = { ...cfg };
    this.h = handlers;
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    // Only ask when not granted yet: on Android every request opens the system
    // permission screen, even for a granted permission, which pauses the app.
    let perm = await AudioManager.checkRecordingPermissions();
    if (perm !== 'Granted') {
      askingPermission = true;
      try { perm = await AudioManager.requestRecordingPermissions(); } finally { askingPermission = false; }
    }
    if (perm !== 'Granted') throw Object.assign(new Error('Microphone permission is needed for voice mode.'), { name: 'NotAllowedError' });
    AudioManager.setAudioSessionOptions({ iosCategory: 'playAndRecord', iosMode: 'voiceChat', iosOptions: ['defaultToSpeaker', 'allowBluetooth'] } as any);
    await AudioManager.setAudioSessionActivity(true);
    // Ended while it was starting (End tapped, app left): open nothing more.
    if (this.closedByUs) return;

    // At the voice's own rate: this library does not resample an AudioBuffer
    // to the context's rate, so 24 kHz speech in a 48 kHz context would play at
    // double speed. The output stream converts to the device rate instead.
    this.ctx = new AudioContext({ sampleRate: TTS_RATE });
    this.duckGain = this.ctx.createGain();
    this.volGain = this.ctx.createGain();
    this.volGain.gain.value = this.cfg.volume;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.duckGain.connect(this.volGain);
    this.volGain.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);

    await recorderStopping.catch(() => {});
    if (this.closedByUs) return;
    const rec = recorder();
    const cb = rec.onAudioReady({ sampleRate: MIC_RATE, bufferLength: FRAME, channelCount: 1 }, ({ buffer }) => this.onMic(buffer.getChannelData(0), buffer.sampleRate));
    if (cb.status === 'error') throw new Error(cb.message || 'The microphone could not start.');
    const r = await rec.start();
    if (r.status === 'error') { rec.clearOnAudioReady(); throw new Error(r.message || 'The microphone could not start.'); }
    if (this.closedByUs) {
      rec.clearOnAudioReady();
      recorderStopping = rec.stop().catch(() => {});
      return;
    }
    this.recording = true;

    await this.connect();
  }

  stop(): void {
    if (this.phase === 'ended') return;
    this.closedByUs = true;
    if (this.cfg.sounds) this.tone('end');
    this.cancelSpeech();
    try { this.ws?.close(); } catch { /* closed */ }
    this.ws = null;
    if (this.recording) {
      this.recording = false;
      const rec = recorder();
      rec.clearOnAudioReady();
      recorderStopping = rec.stop().catch(() => {});
    }
    const ctx = this.ctx;
    setTimeout(() => {
      ctx?.close().catch(() => {});
      AudioManager.setAudioSessionActivity(false).catch(() => {});
    }, 450);
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.setPhase('ended');
  }

  private async connect() {
    const [base, session] = await Promise.all([prefs.getServerUrl(), prefs.getSession()]);
    if (this.closedByUs) return;
    if (!base) { this.fail('Not connected to the planner.'); return; }
    const url = joinUrl(base, '/api/voice/ws').replace(/^http/i, 'ws');
    // React Native's WebSocket takes headers as a third argument.
    const Ctor = WebSocket as unknown as new (u: string, p?: string[] | null, o?: { headers: Record<string, string> }) => WebSocket;
    const ws = new Ctor(url, null, { headers: session ? { Cookie: `${SESSION_COOKIE}=${session}` } : {} });
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.engineReady = false;
    this.setPhase('connecting');
    ws.onopen = () => {
      this.reconnects = 0;
      ws.send(JSON.stringify({ type: 'start', voice: this.cfg.voice, speed: this.cfg.speed, endpointMs: this.cfg.endpointMs, trailBoost: this.cfg.trailBoost, unfinishedBoost: this.cfg.unfinishedBoost, sensitivity: this.cfg.sensitivity, maxTurnS: this.cfg.maxTurnS, hints: this.cfg.hints ?? '' }));
    };
    ws.onmessage = (e: MessageEvent) => {
      if (typeof e.data === 'string') this.onJson(e.data);
      else if (e.data instanceof ArrayBuffer) this.onAudio(e.data);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.engineReady = false;
      if (this.closedByUs || this.phase === 'ended') return;
      if (this.reconnects < 4) {
        this.reconnects++;
        this.setPhase('connecting');
        this.later(() => { if (!this.closedByUs) void this.connect(); }, 600 * this.reconnects);
      } else {
        this.fail('Lost the connection to the speech engine on the PC.');
      }
    };
  }

  private fail(message: string) {
    this.h.onError?.(message);
    this.setPhase('error');
  }

  // ── Microphone ──

  private onMic(samples: Float32Array, rate: number) {
    // The recorder delivers what it was asked for when it can; resample if not.
    const step = rate > 0 && Math.abs(rate - MIC_RATE) > 1 ? rate / MIC_RATE : 1;
    for (let pos = 0; pos < samples.length; pos += step) {
      const i = Math.floor(pos);
      const v = step === 1 ? samples[i] : samples[i] + (samples[Math.min(i + 1, samples.length - 1)] - samples[i]) * (pos - i);
      this.micSq += v * v;
      this.micBuf[this.micN++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
      if (this.micN === FRAME) {
        const frame = this.micBuf;
        this.micBuf = new Int16Array(FRAME);
        this.micN = 0;
        this.micLevel = this.micLevel * 0.5 + Math.sqrt(this.micSq / FRAME) * 0.5;
        this.micSq = 0;
        this.sendFrame(frame);
      }
    }
  }

  private sendFrame(frame: Int16Array) {
    if (this.muted || !this.engineReady) return;
    if (!this.cfg.interrupt && this.isPlaying()) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(frame.buffer as ArrayBuffer);
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
      case 'shutdown':
        // Turned off on purpose (Settings, the toolbar, the Notes app):
        // reconnecting would only start it again.
        this.closedByUs = true;
        this.fail('Voice mode ended: the speech engine was turned off.');
        break;
    }
  }

  private onAudio(buf: ArrayBuffer) {
    if (!this.ctx || !this.duckGain || buf.byteLength < 6) return;
    const id = new DataView(buf).getUint32(0, true);
    if (!this.pending.has(id)) return;
    const pcm = new Int16Array(buf.slice(4, 4 + (((buf.byteLength - 4) >> 1) << 1)));
    const f = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
    const ab = this.ctx.createBuffer(1, f.length, TTS_RATE);
    ab.copyToChannel(f, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = ab;
    src.connect(this.duckGain);
    const at = Math.max(this.ctx.currentTime + 0.05, this.nextAt);
    src.start(at);
    this.nextAt = at + ab.duration;
    this.sources.add(src);
    src.onEnded = () => { this.sources.delete(src); this.checkQuiet(); this.refresh(); };
    if (!this.started.has(id)) {
      this.started.add(id);
      const text = this.pending.get(id) ?? '';
      const gen = this.sayGen;
      this.later(() => { if (gen === this.sayGen) this.h.onSaying?.(id, text); }, Math.max(0, (at - this.ctx.currentTime) * 1000));
    }
    this.setPlaying(true);
    this.refresh();
  }

  // ── Speaking ──

  say(text: string): number {
    const id = ++this.seq;
    const t = text.trim();
    if (!t || !this.ws || this.ws.readyState !== WebSocket.OPEN) return id;
    this.pending.set(id, t);
    const live = this.cfg.livePrefs?.();
    this.ws.send(JSON.stringify({ type: 'speak', id, text: t, voice: live?.voice ?? this.cfg.voice, speed: live?.speed ?? this.cfg.speed }));
    this.setPlaying(true);
    return id;
  }

  cancelSpeech(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'cancel' }));
    this.sayGen++;
    this.pending.clear();
    this.started.clear();
    for (const s of this.sources) { try { s.onEnded = null; s.stop(); } catch { /* done */ } }
    this.sources.clear();
    this.nextAt = 0;
    this.duck(false);
    this.setPlaying(false);
    this.h.onQuiet?.();
  }

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

  finishTurn(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'flush' }));
  }

  configure(patch: Partial<VoiceSessionConfig>): void {
    this.cfg = { ...this.cfg, ...patch };
    if (this.volGain && patch.volume !== undefined && this.ctx) this.volGain.gain.setTargetAtTime(this.cfg.volume, this.ctx.currentTime, 0.05);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'config', voice: this.cfg.voice, speed: this.cfg.speed, endpointMs: this.cfg.endpointMs, trailBoost: this.cfg.trailBoost, unfinishedBoost: this.cfg.unfinishedBoost, sensitivity: this.cfg.sensitivity, maxTurnS: this.cfg.maxTurnS, hints: this.cfg.hints ?? '' }));
    }
  }

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
      o.connect(g);
      g.connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.3);
    }
  }
}
