export interface FocusSession {
  id: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
  plannedSeconds: number;
}

export interface FocusTimerState {
  plannedSeconds: number;
  accumulatedSeconds: number;
  isRunning: boolean;
  lastStartedAt: string | null;
  sessionStartedAt: string | null;
  /**
   * When the timer was last paused. Not used for timekeeping — it exists so that
   * every pause is individually identifiable. Without it, the second pause of a
   * session was indistinguishable from the first and its cue got suppressed as a
   * duplicate. See `focusCueKey`.
   */
  lastPausedAt?: string | null;
  /**
   * How much of the CURRENT session's elapsed time has already been written into
   * a day's total by a manual edit ("Modify Focus Time").
   *
   * Editing a day while a session runs used to fight the running clock: the day
   * total is `logged + elapsed`, so the edit had to guess a logged value that
   * would come out right — and then the still-growing `elapsed` dragged the
   * number up again, and completing the session logged that same elapsed time a
   * second time. Instead, the edit banks the elapsed time so far here: the
   * session keeps running and counting down exactly as before, but only the time
   * run SINCE the edit counts toward the day (and toward the session finally
   * logged). Reset to 0 with every new session.
   */
  creditedSeconds?: number;
  /**
   * When this state was written, in ms. Stamped by whichever window pushed it,
   * and used purely to reject STALE echoes: a burst of duration edits produces a
   * burst of pushes, and the broadcast of an earlier one can land after a later
   * one and drag the number backwards. Deliberately excluded from the identity,
   * push and cue keys — it is metadata about the write, not part of the state.
   */
  updatedAt?: number;
}

export const FOCUS_SESSIONS_KEY = 'planner-focus-sessions';
export const FOCUS_EXCLUDED_DATES_KEY = 'planner-focus-excluded-dates';
export const FOCUS_TIMER_KEY = 'planner-focus-timer';
export const MIN_COMPLETED_SESSION_SECONDS = 20 * 60;

// ── Shutdown / sleep recovery ───────────────────────────────────────────────
// The running timer is just a start timestamp, so a PC that is switched off
// mid-session leaves it "running" for as long as the machine is away. On the
// next launch the countdown was already past zero, so the session auto-completed
// for its FULL planned length and got stamped with the current time — a whole
// hour of focus landing on the wrong day, hours after the machine went to sleep.
//
// The fix is a heartbeat: while a session runs, every live window tells the
// server "this session was still alive at <time>, with <n> seconds on it". If
// that stamp is old, nobody was watching, and the true end of the session is the
// heartbeat — not now, and not the planned duration.
export interface FocusHeartbeat {
  at: string;
  sessionStartedAt: string | null;
  elapsedSeconds: number;
}

export const FOCUS_HEARTBEAT_INTERVAL_MS = 10_000;
/** Older than this and we treat the machine as having been away. */
export const FOCUS_HEARTBEAT_STALE_MS = 90_000;
/** Anything shorter than this isn't worth logging as a session. */
export const MIN_RECOVERED_SESSION_SECONDS = 60;

export function safeFocusHeartbeat(value: unknown): FocusHeartbeat | null {
  if (!value || typeof value !== 'object') return null;
  const b = value as Partial<FocusHeartbeat>;
  if (typeof b.at !== 'string' || Number.isNaN(Date.parse(b.at))) return null;
  return {
    at: b.at,
    sessionStartedAt: typeof b.sessionStartedAt === 'string' ? b.sessionStartedAt : null,
    elapsedSeconds: Math.max(0, Number(b.elapsedSeconds) || 0),
  };
}

export interface FocusRecovery {
  /** When the session actually stopped — the last moment a window saw it alive. */
  endedAt: string;
  durationSeconds: number;
}

/**
 * Decide whether the "running" timer is actually the ghost of a session that
 * died with the machine, and if so where it really ended. Returns null for a
 * genuinely live session.
 */
export function focusRecoveryFor(
  timer: FocusTimerState,
  beat: FocusHeartbeat | null,
  now = Date.now(),
): FocusRecovery | null {
  if (!timer.isRunning || !timer.sessionStartedAt) return null;

  // A session that was toggled/resumed very recently (within heartbeat stale window)
  // is actively running. Stale heartbeat files on disk from before a pause must NOT
  // trigger crash recovery.
  if (timer.lastStartedAt && now - Date.parse(timer.lastStartedAt) <= FOCUS_HEARTBEAT_STALE_MS) {
    return null;
  }

  const matched = beat && beat.sessionStartedAt === timer.sessionStartedAt ? beat : null;
  if (matched) {
    if (now - Date.parse(matched.at) <= FOCUS_HEARTBEAT_STALE_MS) return null; // alive
    return {
      endedAt: matched.at,
      durationSeconds: Math.min(Math.floor(matched.elapsedSeconds), timer.plannedSeconds),
    };
  }

  // No heartbeat for this session (it predates the heartbeat, or the file was
  // lost). We can't know when it stopped, so only act once it has overrun well
  // past its planned length — which only happens unattended — and credit it at
  // the moment it would have finished rather than now.
  const elapsed = getFocusTimerElapsedSeconds(timer, now);
  if (elapsed <= timer.plannedSeconds + FOCUS_HEARTBEAT_STALE_MS / 1000) return null;
  return {
    endedAt: new Date(Date.parse(timer.sessionStartedAt) + timer.plannedSeconds * 1000).toISOString(),
    durationSeconds: timer.plannedSeconds,
  };
}

/** Deterministic, so two windows recovering the same session log it once. */
export function recoveredSessionId(sessionStartedAt: string | null): string {
  return `recovered-${sessionStartedAt ?? 'unknown'}`;
}

export function isCompletedFocusSession(session: FocusSession): boolean {
  return session.durationSeconds >= MIN_COMPLETED_SESSION_SECONDS;
}

// ── Cross-window completion coordination ────────────────────────────────────
// The main window and the side widget each run the same countdown off the same
// shared timer state, so BOTH notice a session finishing. Without coordination
// that means a doubled chime and (worse) two logged sessions. localStorage is
// shared between same-origin windows, so the first one to stamp the key wins and
// the other backs off. Both are also given a deterministic session id below, so
// even if they do race, the two records collapse into one on save.
const CHIME_CLAIM_KEY = 'planner-focus-chime-claim';

export function claimFocusCompletion(withinMs = 6000): boolean {
  try {
    const now = Date.now();
    const last = Number(localStorage.getItem(CHIME_CLAIM_KEY) || 0);
    if (Number.isFinite(last) && now - last < withinMs) return false;
    localStorage.setItem(CHIME_CLAIM_KEY, String(now));
    return true;
  } catch (_) {
    return true; // no storage → just act
  }
}

// Stable id for an auto-completed session so two windows can't log it twice.
export function autoSessionId(sessionStartedAt: string | null, plannedSeconds: number): string {
  return `auto-${sessionStartedAt ?? 'unknown'}-${plannedSeconds}`;
}

export function dedupeFocusSessions(sessions: FocusSession[]): FocusSession[] {
  const seen = new Set<string>();
  return sessions.filter(s => {
    if (seen.has(s.id)) return false;
    seen.add(s.id);
    return true;
  });
}

// ── Session-complete chime ──────────────────────────────────────────────────
// Synthesised with WebAudio rather than shipped as an audio file: no download, no
// decode step, and nothing to go stale. Every voice is deliberately quiet, in a
// low-mid register, and rolled off with a lowpass — the old version was a bare
// C6–E6–G6 sine stack at near-full gain, which read as shrill and abrupt.

export type FocusChimeId =
  | 'bowl'
  | 'zen_bell'
  | 'breath'
  | 'marimba'
  | 'kalimba'
  | 'bamboo'
  | 'drops'
  | 'harp'
  | 'windchimes'
  | 'glass'
  | 'bell'
  | 'rhodes'
  | 'sunrise'
  | 'dreamscape';

export type FocusChimeCategory = 'meditative' | 'acoustic' | 'celestial' | 'ambient';

export interface FocusChimeOption {
  id: FocusChimeId;
  label: string;
  hint: string;
  category: FocusChimeCategory;
}

export const FOCUS_CHIMES: FocusChimeOption[] = [
  // 🧘 Meditative
  { id: 'bowl',        category: 'meditative', label: 'Singing bowl',     hint: 'Deep Tibetan singing bowl with slow binaural beating and serene resonance.' },
  { id: 'zen_bell',    category: 'meditative', label: 'Zen temple gong',  hint: 'Authentic bronze temple bell with deep sub-octave hum and long decay.' },
  { id: 'breath',      category: 'meditative', label: 'Breath of dawn',   hint: 'Ultra-quiet, soothing ambient chord swell that breathes in and fades out.' },

  // 🪵 Acoustic & Organic
  { id: 'marimba',     category: 'acoustic',   label: 'Marimba glow',     hint: 'Warm rosewood marimba chord roll with woody bar overtones.' },
  { id: 'kalimba',     category: 'acoustic',   label: 'Kalimba tines',    hint: 'Sweet African thumb piano flourish with metallic click and wooden body.' },
  { id: 'bamboo',      category: 'acoustic',   label: 'Bamboo chimes',    hint: 'Hollow wooden pipes clattering gently in an organic mountain breeze.' },
  { id: 'drops',       category: 'acoustic',   label: 'Water ripple',     hint: 'Three crystal droplets splashing peacefully into still water.' },

  // ✨ Celestial & Shimmering
  { id: 'harp',        category: 'celestial',  label: 'Celestial harp',   hint: 'Ascending concert harp arpeggio across a lush Eb Major 9 chord.' },
  { id: 'windchimes',  category: 'celestial',  label: 'Windchimes',       hint: 'Breezy cluster of sparkling silver chimes ringing in stereo.' },
  { id: 'glass',       category: 'celestial',  label: 'Glass harp',       hint: 'Pure singing crystal wine glass harmonics with gentle tremolo vibrato.' },
  { id: 'bell',        category: 'celestial',  label: 'Soft bell',        hint: 'Struck orchestral bell with a long crystalline shimmer.' },

  // 🌅 Modern & Ambient
  { id: 'rhodes',      category: 'ambient',    label: 'Warm Rhodes',      hint: 'Lush lo-fi electric piano chord with authentic tine attack and vibrato.' },
  { id: 'sunrise',     category: 'ambient',    label: 'Sunrise horizon',  hint: 'Uplifting major 9th progression welcoming the next part of your day.' },
  { id: 'dreamscape',  category: 'ambient',    label: 'Analog dreamscape',hint: 'Warm 80s vintage analog synth pad swell with rich chorus warmth.' },
];

export const DEFAULT_FOCUS_CHIME: FocusChimeId = 'breath';

export function coerceFocusChime(value: unknown): FocusChimeId {
  return FOCUS_CHIMES.some(c => c.id === value) ? (value as FocusChimeId) : DEFAULT_FOCUS_CHIME;
}

// One context for the page's lifetime. Building a fresh AudioContext per chime
// cost tens of milliseconds and could come up suspended — that was the lag.
let sharedCtx: AudioContext | null = null;
let userGestureUnlocked = false;

if (typeof window !== 'undefined') {
  const unlock = () => {
    userGestureUnlocked = true;
    if (sharedCtx && sharedCtx.state === 'suspended') {
      sharedCtx.resume().catch(() => {});
    }
  };
  window.addEventListener('pointerdown', unlock, { capture: true });
  window.addEventListener('keydown', unlock, { capture: true });
}

function getCtx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!sharedCtx) sharedCtx = new AC();
    if (userGestureUnlocked && sharedCtx.state === 'suspended') {
      sharedCtx.resume().catch(() => {});
    }
    return sharedCtx;
  } catch (_) {
    return null;
  }
}

/**
 * Open (and unlock) the audio context on a user gesture.
 */
export function primeFocusAudio(): void {
  userGestureUnlocked = true;
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === 'running') return;
  try {
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(ctx.destination);
    const osc = ctx.createOscillator();
    osc.connect(g);
    osc.start();
    osc.stop(ctx.currentTime + 0.01);
  } catch (_) { /* ignore */ }
}

/**
 * Run `fn` only once the context is actually running.
 */
function whenRunning(ctx: AudioContext, fn: () => void): void {
  if (ctx.state === 'running') { fn(); return; }
  if (userGestureUnlocked) {
    ctx.resume().then(fn).catch(() => { try { fn(); } catch (_) { /* ignore */ } });
  }
}

interface ToneOpts {
  freq: number;
  at: number;       // seconds from now
  dur: number;
  peak: number;
  type?: OscillatorType;
  attack?: number;
  /** Slight downward pitch drift, like a real struck body. */
  glide?: number;
  /** -1 (left) … 1 (right). Small offsets give the sound width. */
  pan?: number;
  /** Cents of detune. A couple of cents between partials stops it sounding sterile. */
  detune?: number;
  decayStage1Ratio?: number;
}

function tone(ctx: AudioContext, dest: AudioNode, o: ToneOpts): void {
  const t = ctx.currentTime + o.at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.detune) osc.detune.setValueAtTime(o.detune, t);
  if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(10, o.freq * o.glide), t + o.dur);
  const attack = Math.max(0.001, o.attack ?? 0.012);
  g.gain.setValueAtTime(0.00001, t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.00001, o.peak), t + attack);
  // Real struck bodies decay along a curve, not a straight exponential to zero.
  const stage1Ratio = o.decayStage1Ratio ?? 0.32;
  g.gain.exponentialRampToValueAtTime(Math.max(0.00001, o.peak * stage1Ratio), t + attack + o.dur * 0.18);
  g.gain.exponentialRampToValueAtTime(0.00001, t + o.dur);
  osc.connect(g);
  if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    g.connect(p);
    p.connect(dest);
  } else {
    g.connect(dest);
  }
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
}

interface FmToneOpts {
  carrierFreq: number;
  modRatio: number;
  modDepth: number;
  at: number;
  dur: number;
  peak: number;
  attack?: number;
  modAttack?: number;
  modDecay?: number;
  carrierType?: OscillatorType;
  modType?: OscillatorType;
  pan?: number;
  detune?: number;
  tremoloFreq?: number;
  tremoloDepth?: number;
}

function fmTone(ctx: AudioContext, dest: AudioNode, o: FmToneOpts): void {
  const t = ctx.currentTime + o.at;
  const carrier = ctx.createOscillator();
  const carrierGain = ctx.createGain();
  const modulator = ctx.createOscillator();
  const modGain = ctx.createGain();

  carrier.type = o.carrierType ?? 'sine';
  modulator.type = o.modType ?? 'sine';

  const freq = o.carrierFreq;
  carrier.frequency.setValueAtTime(freq, t);
  if (o.detune) carrier.detune.setValueAtTime(o.detune, t);
  modulator.frequency.setValueAtTime(freq * o.modRatio, t);

  // Modulation envelope
  const modAtt = Math.max(0.001, o.modAttack ?? 0.003);
  const modDec = Math.max(0.01, o.modDecay ?? o.dur * 0.25);
  modGain.gain.setValueAtTime(0.0001, t);
  modGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, o.modDepth), t + modAtt);
  modGain.gain.exponentialRampToValueAtTime(Math.max(0.0001, o.modDepth * 0.06), t + modAtt + modDec);
  modGain.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);

  modulator.connect(modGain);
  modGain.connect(carrier.frequency);

  // Carrier amplitude envelope
  const attack = Math.max(0.001, o.attack ?? 0.004);
  carrierGain.gain.setValueAtTime(0.00001, t);
  carrierGain.gain.exponentialRampToValueAtTime(Math.max(0.00001, o.peak), t + attack);
  carrierGain.gain.exponentialRampToValueAtTime(Math.max(0.00001, o.peak * 0.35), t + attack + o.dur * 0.2);
  carrierGain.gain.exponentialRampToValueAtTime(0.00001, t + o.dur);

  carrier.connect(carrierGain);

  let outputNode: AudioNode = carrierGain;

  // Optional tremolo
  if (o.tremoloFreq && o.tremoloDepth) {
    const tremoloOsc = ctx.createOscillator();
    const tremoloGain = ctx.createGain();
    tremoloOsc.frequency.setValueAtTime(o.tremoloFreq, t);
    tremoloGain.gain.setValueAtTime(o.tremoloDepth * 0.5, t);
    const tremoloTarget = ctx.createGain();
    tremoloTarget.gain.setValueAtTime(1 - o.tremoloDepth * 0.5, t);
    tremoloOsc.connect(tremoloGain);
    tremoloGain.connect(tremoloTarget.gain);
    carrierGain.connect(tremoloTarget);
    outputNode = tremoloTarget;
    tremoloOsc.start(t);
    tremoloOsc.stop(t + o.dur + 0.05);
  }

  if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    outputNode.connect(p);
    p.connect(dest);
  } else {
    outputNode.connect(dest);
  }

  modulator.start(t);
  carrier.start(t);
  modulator.stop(t + o.dur + 0.05);
  carrier.stop(t + o.dur + 0.05);
}

interface FilteredToneOpts {
  freq: number;
  at: number;
  dur: number;
  peak: number;
  type?: OscillatorType;
  attack?: number;
  filterType?: BiquadFilterType;
  filterStart: number;
  filterPeak?: number;
  filterEnd: number;
  filterQ?: number;
  detune?: number;
  pan?: number;
}

function filteredTone(ctx: AudioContext, dest: AudioNode, o: FilteredToneOpts): void {
  const t = ctx.currentTime + o.at;
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const gain = ctx.createGain();

  osc.type = o.type ?? 'sawtooth';
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.detune) osc.detune.setValueAtTime(o.detune, t);

  filter.type = o.filterType ?? 'lowpass';
  filter.Q.value = o.filterQ ?? 2.0;
  filter.frequency.setValueAtTime(Math.max(20, o.filterStart), t);
  const filterPeak = o.filterPeak ?? o.filterStart * 2.5;
  const attack = Math.max(0.005, o.attack ?? 0.1);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, filterPeak), t + attack);
  filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.filterEnd), t + o.dur);

  gain.gain.setValueAtTime(0.00001, t);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.00001, o.peak), t + attack);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.00001, o.peak * 0.4), t + attack + o.dur * 0.35);
  gain.gain.exponentialRampToValueAtTime(0.00001, t + o.dur);

  osc.connect(filter);
  filter.connect(gain);

  if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, o.pan));
    gain.connect(p);
    p.connect(dest);
  } else {
    gain.connect(dest);
  }

  osc.start(t);
  osc.stop(t + o.dur + 0.05);
}

interface NoiseBurstOpts {
  at: number;
  dur: number;
  peak: number;
  filterFreq: number;
  filterQ?: number;
  filterType?: BiquadFilterType;
  pan?: number;
}

function noiseBurst(ctx: AudioContext, dest: AudioNode, o: NoiseBurstOpts): void {
  try {
    const t = ctx.currentTime + o.at;
    const bufferSize = Math.floor(ctx.sampleRate * Math.max(0.005, o.dur));
    const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) {
      data[i] = Math.random() * 2 - 1;
    }

    const noise = ctx.createBufferSource();
    noise.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = o.filterType ?? 'bandpass';
    filter.frequency.setValueAtTime(o.filterFreq, t);
    filter.Q.value = o.filterQ ?? 4.0;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(Math.max(0.00001, o.peak), t);
    gain.gain.exponentialRampToValueAtTime(0.00001, t + o.dur);

    noise.connect(filter);
    filter.connect(gain);

    if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, o.pan));
      gain.connect(p);
      p.connect(dest);
    } else {
      gain.connect(dest);
    }

    noise.start(t);
    noise.stop(t + o.dur + 0.02);
  } catch (_) { /* ignore noise generation errors */ }
}

// A small algorithmic room, rendered once and reused. Reverb is most of what
// separates "a beep" from something that sounds like it was recorded in a space.
let sharedIR: AudioBuffer | null = null;

function getReverbIR(ctx: AudioContext): AudioBuffer {
  if (sharedIR) return sharedIR;
  const seconds = 2.4;
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const progress = i / len;
      // Exponential decay of shaped noise, darkening as it fades.
      const decay = Math.pow(1 - progress, 2.6);
      data[i] = (Math.random() * 2 - 1) * decay * (1 - progress * 0.5);
    }
  }
  sharedIR = buf;
  return buf;
}

/**
 * Master chain: dry level → gentle lowpass → out, with a parallel reverb send.
 * The lowpass takes the glassy edge off; the reverb is what gives the sound
 * depth instead of the flat "computer beep" quality of the old version.
 */
function buildChain(ctx: AudioContext, cutoff = 3400): { master: GainNode; send: GainNode } {
  const master = ctx.createGain();
  master.gain.value = 0.5;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  lp.Q.value = 0.35;
  // A touch of compression keeps overlapping partials from stacking into a peak.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -22;
  comp.knee.value = 26;
  comp.ratio.value = 3;
  comp.attack.value = 0.006;
  comp.release.value = 0.28;

  master.connect(lp);
  lp.connect(comp);
  comp.connect(ctx.destination);

  const send = ctx.createGain();
  send.gain.value = 0;
  try {
    const verb = ctx.createConvolver();
    verb.buffer = getReverbIR(ctx);
    const verbTone = ctx.createBiquadFilter();
    verbTone.type = 'lowpass';
    verbTone.frequency.value = 2400;
    lp.connect(send);
    send.connect(verb);
    verb.connect(verbTone);
    verbTone.connect(comp);
  } catch (_) { /* no convolver support — dry only */ }

  return { master, send };
}

let lastChimePlayTime = 0;

export function playFocusChime(id: FocusChimeId = DEFAULT_FOCUS_CHIME): void {
  const now = Date.now();
  if (now - lastChimePlayTime < 600) return;
  lastChimePlayTime = now;

  const ctx = getCtx();
  if (!ctx) return;
  whenRunning(ctx, () => renderChime(ctx, id));
}

function renderChime(ctx: AudioContext, id: FocusChimeId): void {
  try {
    const { master, send } = buildChain(ctx);
    let wetAmount = 0.35;

    switch (coerceFocusChime(id)) {
      // 🧘 MEDITATIVE ──────────────────────────────────────────────────────────
      case 'bowl': {
        // Singing bowl: low fundamental (F3 = 174.6Hz) with a beating partner a few cents
        // away (that slow hypnotic throb is the signature of a real Tibetan bowl),
        // resonant 2.76x and 5.4x partials, and a high singing rim overtone.
        wetAmount = 0.52;
        noiseBurst(ctx, master, { at: 0, dur: 0.035, peak: 0.02, filterFreq: 380, filterQ: 3.5, pan: 0 });
        tone(ctx, master, { freq: 174.61, at: 0, dur: 4.2, peak: 0.16, attack: 0.08, pan: -0.15 });
        tone(ctx, master, { freq: 174.61, at: 0, dur: 4.0, peak: 0.12, attack: 0.09, detune: 4.2, pan: 0.15 });
        tone(ctx, master, { freq: 174.61 * 2.76, at: 0.02, dur: 3.2, peak: 0.055, attack: 0.12, pan: 0.22 });
        tone(ctx, master, { freq: 174.61 * 5.4, at: 0.04, dur: 2.4, peak: 0.022, attack: 0.15, pan: -0.22 });
        tone(ctx, master, { freq: 174.61 * 8.9, at: 0.06, dur: 1.8, peak: 0.012, attack: 0.18, pan: 0.08 });
        break;
      }

      case 'zen_bell': {
        // Japanese Rin gong / Buddhist temple bell: deep bronze with inharmonic partials
        // (hum sub-octave lingering longest, prime fundamental, and strike overtones).
        wetAmount = 0.55;
        noiseBurst(ctx, master, { at: 0, dur: 0.025, peak: 0.04, filterFreq: 900, filterQ: 4.0, pan: 0 });
        const f = 277.18; // Db4
        tone(ctx, master, { freq: f * 0.5, at: 0, dur: 4.4, peak: 0.09, attack: 0.02, pan: 0 });
        tone(ctx, master, { freq: f, at: 0, dur: 3.8, peak: 0.14, attack: 0.005, pan: -0.1 });
        const partials: [number, number, number, number][] = [
          [1.19, 0.065, 3.2, 0.12],
          [1.50, 0.048, 2.8, -0.18],
          [2.00, 0.042, 2.2, 0.18],
          [2.74, 0.024, 1.6, -0.1],
          [4.15, 0.014, 1.0, 0.15],
        ];
        partials.forEach(([ratio, peak, dur, pan]) => {
          tone(ctx, master, { freq: f * ratio, at: 0, dur, peak, attack: 0.006, pan });
        });
        break;
      }

      case 'breath': {
        // Slow swell on a warm Major 9th chord voicing (Fmaj9). Opens gently with a
        // sweeping resonant lowpass filter and exhales out smoothly.
        wetAmount = 0.55;
        const notes = [174.61, 261.63, 329.63, 392.00, 440.00, 523.25];
        notes.forEach((f, i) => {
          const pan = ((i / (notes.length - 1)) - 0.5) * 0.6;
          filteredTone(ctx, master, {
            freq: f,
            at: i * 0.03,
            dur: 3.2,
            peak: 0.055,
            type: 'triangle',
            attack: 1.1,
            filterStart: 350,
            filterPeak: 1200,
            filterEnd: 250,
            filterQ: 1.2,
            detune: (i % 2 === 0 ? 3 : -3),
            pan,
          });
        });
        break;
      }

      // 🪵 ACOUSTIC & ORGANIC ──────────────────────────────────────────────────
      case 'marimba': {
        // Warm Honduran rosewood marimba chord roll in C Major 9 (C4, G4, E5, B5, D6).
        // Each bar produces woody transient noise, fundamental, 4x double-octave, and strike overtones.
        wetAmount = 0.28;
        const freqs = [261.63, 392.00, 659.25, 987.77, 1174.66];
        freqs.forEach((f, i) => {
          const at = i * 0.04;
          const pan = (i - 2) * 0.18;
          noiseBurst(ctx, master, { at, dur: 0.012, peak: 0.025, filterFreq: 1800, filterQ: 4.5, pan });
          tone(ctx, master, { freq: f, at, dur: 0.72, peak: 0.13, attack: 0.003, pan });
          tone(ctx, master, { freq: f * 4.0, at, dur: 0.24, peak: 0.032, attack: 0.002, pan });
          tone(ctx, master, { freq: f * 10.0, at, dur: 0.07, peak: 0.012, attack: 0.002, pan });
        });
        break;
      }

      case 'kalimba': {
        // African thumb piano / mbira: FM metallic tine plucks layered with resonant wooden body knock.
        wetAmount = 0.35;
        const kalimbaNotes = [
          { f: 329.63, at: 0.00,  pan: -0.3 },
          { f: 493.88, at: 0.065, pan: 0.25 },
          { f: 659.25, at: 0.13,  pan: -0.2 },
          { f: 830.61, at: 0.195, pan: 0.2 },
          { f: 987.77, at: 0.26,  pan: 0.0 },
        ];
        kalimbaNotes.forEach(({ f, at, pan }) => {
          fmTone(ctx, master, {
            carrierFreq: f,
            modRatio: 5.42,
            modDepth: 380,
            at,
            dur: 0.85,
            peak: 0.13,
            attack: 0.002,
            modDecay: 0.055,
            pan,
          });
          tone(ctx, master, { freq: 175, at, dur: 0.14, peak: 0.045, attack: 0.002, glide: 0.9, pan });
        });
        break;
      }

      case 'bamboo': {
        // Hollow bamboo pipes clattering in a mountain breeze with pitch glide transients and organic timing.
        wetAmount = 0.38;
        const bambooHits = [
          { f: 440, at: 0.00, glide: 0.88, pan: -0.32, dur: 0.35 },
          { f: 730, at: 0.08, glide: 0.91, pan: 0.28,  dur: 0.28 },
          { f: 580, at: 0.17, glide: 0.89, pan: -0.15, dur: 0.32 },
          { f: 920, at: 0.24, glide: 0.92, pan: 0.22,  dur: 0.24 },
          { f: 350, at: 0.32, glide: 0.86, pan: 0.0,   dur: 0.42 },
        ];
        bambooHits.forEach(({ f, at, glide, pan, dur }) => {
          noiseBurst(ctx, master, { at, dur: 0.018, peak: 0.035, filterFreq: f * 1.5, filterQ: 6.0, pan });
          tone(ctx, master, { freq: f, at, dur, peak: 0.11, attack: 0.003, glide, pan, type: 'triangle' });
          tone(ctx, master, { freq: f * 2.4, at, dur: dur * 0.4, peak: 0.025, attack: 0.002, glide, pan });
        });
        break;
      }

      case 'drops': {
        // Three crystal droplets falling into still water with pitch glides and soothing ripple overtones.
        wetAmount = 0.45;
        tone(ctx, master, { freq: 720, at: 0.00, dur: 0.35, peak: 0.12, attack: 0.004, glide: 1.6, pan: -0.28 });
        tone(ctx, master, { freq: 1850, at: 0.01, dur: 0.12, peak: 0.025, attack: 0.002, pan: -0.28 });

        tone(ctx, master, { freq: 540, at: 0.18, dur: 0.42, peak: 0.11, attack: 0.004, glide: 1.55, pan: 0.26 });
        tone(ctx, master, { freq: 1420, at: 0.19, dur: 0.14, peak: 0.022, attack: 0.002, pan: 0.26 });

        tone(ctx, master, { freq: 380, at: 0.38, dur: 0.55, peak: 0.10, attack: 0.004, glide: 1.5, pan: -0.05 });
        tone(ctx, master, { freq: 440, at: 0.40, dur: 1.2, peak: 0.045, attack: 0.08, pan: 0 });
        break;
      }

      // ✨ CELESTIAL & SHIMMERING ───────────────────────────────────────────────
      case 'harp': {
        // Celestial harp glissando across an Eb Major 9 chord (Eb4 -> F6) with warm string harmonics.
        wetAmount = 0.50;
        const harpNotes = [311.13, 466.16, 622.25, 783.99, 932.33, 1174.66, 1396.91];
        harpNotes.forEach((f, i) => {
          const at = i * 0.045;
          const pan = ((i / (harpNotes.length - 1)) - 0.5) * 0.8;
          tone(ctx, master, { freq: f, at, dur: 1.6 - i * 0.1, peak: 0.12, attack: 0.003, type: 'triangle', pan });
          tone(ctx, master, { freq: f * 2.0, at, dur: 0.9, peak: 0.035, attack: 0.002, pan });
          tone(ctx, master, { freq: f * 3.0, at, dur: 0.4, peak: 0.015, attack: 0.002, pan });
        });
        break;
      }

      case 'windchimes': {
        // Breeze catching tuned silver tubes: high FM metallic rings with stereo spread and shimmering delay.
        wetAmount = 0.48;
        const chimeNotes = [
          { f: 1318.5, at: 0.00,  pan: -0.4 },
          { f: 1661.2, at: 0.035, pan: 0.35 },
          { f: 1975.5, at: 0.075, pan: -0.15 },
          { f: 2489.0, at: 0.115, pan: 0.4 },
          { f: 2959.9, at: 0.16,  pan: -0.3 },
          { f: 3322.4, at: 0.205, pan: 0.1 },
        ];
        chimeNotes.forEach(({ f, at, pan }) => {
          fmTone(ctx, master, {
            carrierFreq: f,
            modRatio: 2.76,
            modDepth: 650,
            at,
            dur: 1.4,
            peak: 0.07,
            attack: 0.002,
            modDecay: 0.08,
            pan,
          });
          tone(ctx, master, { freq: f, at, dur: 1.8, peak: 0.05, attack: 0.002, pan });
        });
        break;
      }

      case 'glass': {
        // Pure singing wine glass / crystal bowl: pure sine FM, subtle 4.2Hz rubbing tremolo vibrato.
        wetAmount = 0.52;
        const glassNotes = [
          { f: 440.00,  at: 0.00, pan: -0.3 },
          { f: 659.25,  at: 0.08, pan: 0.3 },
          { f: 987.77,  at: 0.16, pan: -0.15 },
          { f: 1108.73, at: 0.24, pan: 0.15 },
        ];
        glassNotes.forEach(({ f, at, pan }) => {
          fmTone(ctx, master, {
            carrierFreq: f,
            modRatio: 1.0,
            modDepth: 80,
            at,
            dur: 2.8,
            peak: 0.08,
            attack: 0.25,
            modDecay: 1.5,
            tremoloFreq: 4.2,
            tremoloDepth: 0.35,
            pan,
          });
          tone(ctx, master, { freq: f * 2.0, at: at + 0.1, dur: 2.0, peak: 0.02, attack: 0.3, pan });
          tone(ctx, master, { freq: f * 3.0, at: at + 0.15, dur: 1.4, peak: 0.008, attack: 0.35, pan });
        });
        break;
      }

      case 'bell': {
        // Struck orchestral bell with classic inharmonic metallic series.
        wetAmount = 0.46;
        const f = 523.25;
        const partials: [number, number, number, number][] = [
          [0.5,  0.085, 3.2, 0.0],
          [1.0,  0.14,  2.8, -0.1],
          [1.19, 0.055, 2.0, 0.18],
          [1.5,  0.045, 1.6, -0.15],
          [2.0,  0.05,  1.5, 0.12],
          [2.51, 0.022, 0.9, -0.08],
          [3.01, 0.014, 0.6, 0.1],
        ];
        partials.forEach(([ratio, peak, dur, pan], i) => {
          tone(ctx, master, {
            freq: f * ratio, at: 0, dur, peak,
            attack: 0.003 + i * 0.001,
            detune: (i % 2 === 0 ? 1 : -1) * 2.5,
            pan,
          });
        });
        break;
      }

      // 🌅 MODERN & AMBIENT ───────────────────────────────────────────────────
      case 'rhodes': {
        // Vintage lo-fi electric piano chord (Fmaj9#11) with FM tine attack and soft tremolo vibrato.
        wetAmount = 0.38;
        const rhodesChord = [
          { f: 174.61, pan: -0.35 },
          { f: 261.63, pan: -0.2 },
          { f: 329.63, pan: -0.05 },
          { f: 392.00, pan: 0.1 },
          { f: 493.88, pan: 0.25 },
          { f: 659.25, pan: 0.4 },
        ];
        rhodesChord.forEach(({ f, pan }, i) => {
          const at = i * 0.015;
          fmTone(ctx, master, {
            carrierFreq: f,
            modRatio: 14.0,
            modDepth: 450,
            at,
            dur: 2.2,
            peak: 0.09,
            attack: 0.002,
            modDecay: 0.08,
            tremoloFreq: 4.8,
            tremoloDepth: 0.3,
            pan,
          });
          tone(ctx, master, { freq: f, at, dur: 2.4, peak: 0.06, attack: 0.008, pan });
        });
        break;
      }

      case 'sunrise': {
        // Uplifting 2-stage major 9th progression (Abmaj7 -> Cmaj9) with warm synth swell and sparkle.
        wetAmount = 0.46;
        const stage1 = [207.65, 261.63, 311.13, 392.00];
        stage1.forEach((f, i) => {
          tone(ctx, master, { freq: f, at: 0, dur: 1.2, peak: 0.07, attack: 0.05, type: 'triangle', pan: (i - 1.5) * 0.2 });
        });
        const stage2 = [261.63, 329.63, 392.00, 493.88, 587.33, 659.25];
        stage2.forEach((f, i) => {
          const at = 0.26 + i * 0.035;
          const pan = ((i / (stage2.length - 1)) - 0.5) * 0.7;
          filteredTone(ctx, master, {
            freq: f,
            at,
            dur: 2.4,
            peak: 0.065,
            type: 'sawtooth',
            attack: 0.04,
            filterStart: 600,
            filterPeak: 2200,
            filterEnd: 400,
            filterQ: 2.0,
            pan,
          });
          tone(ctx, master, { freq: f * 2.0, at, dur: 0.9, peak: 0.02, attack: 0.003, pan });
        });
        break;
      }

      case 'dreamscape': {
        // 80s vintage warm polyphonic synth pad (Dbmaj9) with resonant filter envelope and stereo chorus.
        wetAmount = 0.50;
        const dreamNotes = [138.59, 207.65, 261.63, 311.13, 349.23, 415.30];
        dreamNotes.forEach((f, i) => {
          const pan = ((i / (dreamNotes.length - 1)) - 0.5) * 0.7;
          filteredTone(ctx, master, {
            freq: f,
            at: 0,
            dur: 3.4,
            peak: 0.06,
            type: 'sawtooth',
            attack: 0.6,
            filterStart: 250,
            filterPeak: 1900,
            filterEnd: 300,
            filterQ: 2.8,
            detune: -5,
            pan,
          });
          filteredTone(ctx, master, {
            freq: f,
            at: 0.05,
            dur: 3.3,
            peak: 0.05,
            type: 'triangle',
            attack: 0.65,
            filterStart: 250,
            filterPeak: 1900,
            filterEnd: 300,
            filterQ: 2.8,
            detune: 5,
            pan: -pan,
          });
        });
        break;
      }

      default: {
        // Fallback default singing bowl
        wetAmount = 0.5;
        tone(ctx, master, { freq: 261.6, at: 0, dur: 3.4, peak: 0.15, attack: 0.07, pan: -0.15 });
        tone(ctx, master, { freq: 261.6, at: 0, dur: 3.2, peak: 0.09, attack: 0.09, detune: 7, pan: 0.15 });
        tone(ctx, master, { freq: 392.0, at: 0.03, dur: 2.8, peak: 0.06, attack: 0.11, pan: 0.22 });
        tone(ctx, master, { freq: 654.0, at: 0.06, dur: 2.0, peak: 0.025, attack: 0.14, pan: -0.22 });
        break;
      }
    }

    send.gain.value = wetAmount;
  } catch (_) { /* audio unavailable — ignore */ }
}

// ── Start / pause / resume cues ─────────────────────────────────────────────
// Deliberately much shorter and quieter than the completion chime: these fire
// several times a session, so anything with a tail would wear thin fast. Every
// slot can be set to 'none', which plays nothing at all.

export type FocusCueId = 'none' | 'tap' | 'pebble' | 'rise' | 'fall' | 'pop' | 'shimmer';

export const FOCUS_CUES: { id: FocusCueId; label: string; hint: string }[] = [
  { id: 'none',    label: 'No sound', hint: 'Silent.' },
  { id: 'tap',     label: 'Tap',      hint: 'Dry wooden tick. Barely there.' },
  { id: 'pebble',  label: 'Pebble',   hint: 'Rounded low knock.' },
  { id: 'rise',    label: 'Rise',     hint: 'Two notes stepping up.' },
  { id: 'fall',    label: 'Fall',     hint: 'Two notes stepping down.' },
  { id: 'pop',     label: 'Pop',      hint: 'Soft bubble.' },
  { id: 'shimmer', label: 'Shimmer',  hint: 'Brief airy sparkle.' },
];

export type FocusCueSlot = 'start' | 'pause' | 'resume';

export const DEFAULT_FOCUS_CUES: Record<FocusCueSlot, FocusCueId> = {
  start: 'rise',
  pause: 'fall',
  resume: 'rise',
};

export function coerceFocusCue(value: unknown, slot: FocusCueSlot): FocusCueId {
  return FOCUS_CUES.some(c => c.id === value) ? (value as FocusCueId) : DEFAULT_FOCUS_CUES[slot];
}

/**
 * Both windows watch the same timer, so both would fire the same cue. The server
 * arbitrates: whoever asks first plays it, the other stays quiet.
 *
 * It has to be the server rather than localStorage — the main window is Chrome
 * and the widget is a WebView2, so they have entirely separate storage and a
 * local claim would always succeed in both.
 */
/**
 * Play a cue exactly once across every open window.
 *
 * `playIfUnreachable` decides what happens when the claim itself fails — which
 * happens for real whenever the dev server restarts. Answering "yes" in every
 * window is what makes the sound play TWICE, so only the window that performed
 * the toggle should say yes; the other one stays quiet and nothing is doubled.
 */
const clientClaimedCueKeys = new Set<string>();

export function claimFocusCue(
  key: string,
  play: () => void,
  opts: { playIfUnreachable?: boolean } = {},
): void {
  if (!key) return;
  if (clientClaimedCueKeys.has(key)) return;
  clientClaimedCueKeys.add(key);
  setTimeout(() => clientClaimedCueKeys.delete(key), 8000);

  const { playIfUnreachable = true } = opts;
  const ask = () => {
    fetch(`/api/focus-cue/claim?key=${encodeURIComponent(key)}`, { method: 'POST' })
      .then(r => r.json())
      .then(r => { if (r && r.granted) play(); })
      .catch(() => { if (playIfUnreachable) play(); });
  };

  // Winning the claim is useless if this window can't actually make a sound —
  // the other one stays silent and you hear nothing at all. A window with a
  // sleeping audio context wakes it and defers, so one that is already awake
  // gets first refusal. This is why the cue went missing at random.
  const ctx = getCtx();
  if (ctx && ctx.state !== 'running') {
    ctx.resume().catch(() => {});
    setTimeout(ask, 150);
    return;
  }
  ask();
}

let lastCuePlayTime = 0;
let lastCuePlayId = '';

export function playFocusCue(id: FocusCueId): void {
  if (id === 'none') return;
  const now = Date.now();
  if (id === lastCuePlayId && now - lastCuePlayTime < 50) return;
  lastCuePlayTime = now;
  lastCuePlayId = id;

  const ctx = getCtx();
  if (!ctx) return;
  whenRunning(ctx, () => renderCue(ctx, id));
}

function renderCue(ctx: AudioContext, id: FocusCueId): void {
  try {
    const { master, send } = buildChain(ctx, 4200);
    let wet = 0.12;

    switch (id) {
      case 'tap':
        // Short, high, near-instant attack — reads as a fingernail on wood.
        tone(ctx, master, { freq: 1180, at: 0, dur: 0.075, peak: 0.075, attack: 0.001, glide: 0.82 });
        tone(ctx, master, { freq: 2360, at: 0, dur: 0.035, peak: 0.02,  attack: 0.001 });
        wet = 0.08;
        break;
      case 'pebble':
        tone(ctx, master, { freq: 320, at: 0, dur: 0.19, peak: 0.11, attack: 0.002, glide: 0.72 });
        tone(ctx, master, { freq: 640, at: 0, dur: 0.07, peak: 0.03, attack: 0.002, glide: 0.72 });
        wet = 0.16;
        break;
      case 'rise':
        tone(ctx, master, { freq: 523.25, at: 0,    dur: 0.16, peak: 0.09, attack: 0.004, pan: -0.12 });
        tone(ctx, master, { freq: 783.99, at: 0.07, dur: 0.26, peak: 0.08, attack: 0.004, pan: 0.12 });
        wet = 0.2;
        break;
      case 'fall':
        tone(ctx, master, { freq: 659.25, at: 0,    dur: 0.16, peak: 0.085, attack: 0.004, pan: 0.12 });
        tone(ctx, master, { freq: 440.0,  at: 0.07, dur: 0.3,  peak: 0.08,  attack: 0.004, pan: -0.12 });
        wet = 0.2;
        break;
      case 'pop':
        // A fast upward pitch bend is what the ear hears as a bubble surfacing.
        tone(ctx, master, { freq: 420, at: 0, dur: 0.1, peak: 0.1, attack: 0.002, glide: 2.1 });
        wet = 0.1;
        break;
      case 'shimmer':
        [1046.5, 1568.0, 2093.0].forEach((f, i) => {
          tone(ctx, master, {
            freq: f, at: i * 0.028, dur: 0.22 - i * 0.05, peak: 0.045 - i * 0.012,
            attack: 0.003, pan: (i - 1) * 0.3,
          });
        });
        wet = 0.3;
        break;
    }

    send.gain.value = wet;
  } catch (_) { /* audio unavailable — ignore */ }
}

export const DEFAULT_FOCUS_TIMER: FocusTimerState = {
  plannedSeconds: 60 * 60,
  accumulatedSeconds: 0,
  isRunning: false,
  lastStartedAt: null,
  sessionStartedAt: null,
  lastPausedAt: null,
  creditedSeconds: 0,
};

export function dateKey(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Which "focus day" a moment belongs to, given a configurable day-start hour.
// e.g. with dayStartHour = 3, anything before 3:00 AM counts toward the previous
// calendar day. dayStartHour = 0 reproduces plain calendar-day bucketing.
// The returned key is the calendar date of the day the moment belongs to.
export function focusDayKey(value: Date | string, dayStartHour = 0): string {
  const d = typeof value === 'string' ? new Date(value) : new Date(value);
  // Use the local wall-clock hour directly: anything before the cutoff belongs to
  // the previous calendar day. setDate() rolls month/year over and is DST-safe
  // (it operates on the local calendar, not a fixed millisecond offset).
  const shifted = new Date(d);
  if (d.getHours() < dayStartHour) {
    shifted.setDate(shifted.getDate() - 1);
  }
  return dateKey(shifted);
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function safeFocusSessions(value: unknown): FocusSession[] {
  if (!Array.isArray(value)) return [];
  return value.filter((s): s is FocusSession => {
    if (!s || typeof s !== 'object') return false;
    const item = s as Partial<FocusSession>;
    return (
      typeof item.id === 'string' &&
      typeof item.startedAt === 'string' &&
      typeof item.endedAt === 'string' &&
      typeof item.durationSeconds === 'number' &&
      item.durationSeconds > 0
    );
  });
}

export function loadLocalFocusSessions(): FocusSession[] {
  try {
    return safeFocusSessions(JSON.parse(localStorage.getItem(FOCUS_SESSIONS_KEY) || '[]'));
  } catch (_) {
    return [];
  }
}

export function safeFocusExcludedDates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((k): k is string => typeof k === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(k));
}

export function loadLocalFocusExcludedDates(): string[] {
  try {
    return safeFocusExcludedDates(JSON.parse(localStorage.getItem(FOCUS_EXCLUDED_DATES_KEY) || '[]'));
  } catch (_) {
    return [];
  }
}

export function saveLocalFocusExcludedDates(excluded: string[]): void {
  try {
    localStorage.setItem(FOCUS_EXCLUDED_DATES_KEY, JSON.stringify(safeFocusExcludedDates(excluded)));
  } catch (_) {
    /* ignore private mode */
  }
}

export function coerceFocusTimer(parsed: unknown): FocusTimerState {
  if (!parsed || typeof parsed !== 'object') return DEFAULT_FOCUS_TIMER;
  const p = parsed as Partial<FocusTimerState>;
  return {
    plannedSeconds: Number(p.plannedSeconds) || DEFAULT_FOCUS_TIMER.plannedSeconds,
    accumulatedSeconds: Math.max(0, Number(p.accumulatedSeconds) || 0),
    isRunning: Boolean(p.isRunning),
    lastStartedAt: typeof p.lastStartedAt === 'string' ? p.lastStartedAt : null,
    sessionStartedAt: typeof p.sessionStartedAt === 'string' ? p.sessionStartedAt : null,
    lastPausedAt: typeof p.lastPausedAt === 'string' ? p.lastPausedAt : null,
    creditedSeconds: Math.max(0, Math.floor(Number(p.creditedSeconds) || 0)),
    updatedAt: Number.isFinite(Number(p.updatedAt)) ? Number(p.updatedAt) : undefined,
  };
}

/**
 * The timer state as the two windows compare it — the write timestamp stripped
 * out. Without this every push would look like a different state to the other
 * window (and to the sender's own echo check), which is precisely the loop that
 * made rapid +/- edits stutter.
 */
export function focusTimerIdentity(timer: FocusTimerState): string {
  const { updatedAt: _ignored, ...rest } = coerceFocusTimer(timer);
  return JSON.stringify(rest);
}

/**
 * Everything about a timer EXCEPT its planned duration. Equal keys mean the user
 * only nudged the length — safe to coalesce into one write a moment later, where
 * a start/pause/resume has to reach the other window immediately.
 */
export function focusTimerTransitionKey(timer: FocusTimerState): string {
  const t = coerceFocusTimer(timer);
  return `${t.isRunning}|${t.sessionStartedAt ?? ''}|${t.lastStartedAt ?? ''}|${t.lastPausedAt ?? ''}|${t.accumulatedSeconds}|${t.creditedSeconds}`;
}

/**
 * A stable, globally unique name for one start/pause/resume transition.
 *
 * Both windows must derive the *same* string for the same transition (so only
 * one of them sounds it) and a *different* string for every other transition (so
 * no later cue is ever mistaken for a duplicate). `lastStartedAt` and
 * `lastPausedAt` are fresh millisecond timestamps written by whoever performed
 * the toggle, which gives exactly that — no time windows, no guessing.
 */
export function focusCueKey(slot: FocusCueSlot, timer: FocusTimerState): string {
  const rawStamp = timer.lastStartedAt || timer.lastPausedAt || timer.sessionStartedAt || '';
  const parsedMs = rawStamp ? Date.parse(rawStamp) : 0;
  const timeBucket = Number.isFinite(parsedMs) && parsedMs > 0 ? Math.floor(parsedMs / 4000) : 0;
  return `${slot}|${timer.sessionStartedAt ?? ''}|${timeBucket}`;
}

export function loadLocalFocusTimer(): FocusTimerState {
  try {
    return coerceFocusTimer(JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY) || 'null'));
  } catch (_) {
    return DEFAULT_FOCUS_TIMER;
  }
}

/**
 * What actually needs pushing to the shared backend.
 *
 * While a session runs, the periodic checkpoint keeps re-anchoring
 * `lastStartedAt` and folding the elapsed time into `accumulatedSeconds`. That
 * pair always describes the same total, so it carries no new information — but
 * pushing it would overwrite a start/pause someone else just made (the widget,
 * or the system-wide hotkey) with our stale "still running" view. Keying pushes
 * on this makes a checkpoint a local-only operation.
 */
export function focusTimerPushKey(timer: FocusTimerState): string {
  return JSON.stringify({
    plannedSeconds: timer.plannedSeconds,
    isRunning: timer.isRunning,
    sessionStartedAt: timer.sessionStartedAt,
    accumulatedSeconds: timer.isRunning ? null : timer.accumulatedSeconds,
    // A manual day edit while the session runs changes nothing else here, and it
    // MUST reach the widget and the desk display — otherwise they keep counting
    // the time the edit already banked and drift away from the main window.
    creditedSeconds: timer.creditedSeconds ?? 0,
  });
}

export function getFocusTimerElapsedSeconds(timer: FocusTimerState, now = Date.now()): number {
  const anchor = timer.lastStartedAt ? Date.parse(timer.lastStartedAt) : NaN;
  const runningSeconds = timer.isRunning && Number.isFinite(anchor)
    ? Math.max(0, Math.floor((now - anchor) / 1000))
    : 0;
  return Math.max(0, Math.floor(timer.accumulatedSeconds + runningSeconds));
}

/**
 * What the running session still contributes to its day's total.
 *
 * The countdown keeps using the full elapsed time — a manual edit must never
 * shorten or lengthen the session the user is sitting in. Only the *day total*
 * ignores the part that a manual edit already wrote into the day.
 */
export function getFocusTimerUncreditedSeconds(timer: FocusTimerState, now = Date.now()): number {
  return Math.max(0, getFocusTimerElapsedSeconds(timer, now) - Math.max(0, timer.creditedSeconds ?? 0));
}

/**
 * The duration to log when a session ends: whatever it ran, minus the part a
 * manual day edit already banked. Without this, editing today's total and then
 * finishing the session counted the pre-edit time twice.
 */
export function loggableSessionSeconds(timer: FocusTimerState, rawSeconds: number): number {
  return Math.max(0, Math.floor(rawSeconds) - Math.max(0, timer.creditedSeconds ?? 0));
}

/**
 * Bank the time run so far into `accumulatedSeconds` without losing any of it.
 *
 * This is called every few seconds while a session runs so that closing the app
 * mid-session never loses progress. The subtle part is the new anchor: it must
 * move forward by *exactly* the whole seconds just credited, NOT to "now".
 * Anchoring to now discards the sub-second remainder on every single fold —
 * ~0.4s each time, which is ~3 minutes an hour of focus time silently vanishing.
 * The countdown then ran visibly slow, and pausing (which recomputes the true
 * total) made it appear to jump backwards by minutes.
 */
export function checkpointFocusTimer(timer: FocusTimerState, now = Date.now()): FocusTimerState {
  if (!timer.isRunning || !timer.lastStartedAt) return timer;
  const anchor = Date.parse(timer.lastStartedAt);
  if (!Number.isFinite(anchor)) return timer;
  // A negative span means the clock went backwards (NTP correction, timezone
  // fiddling). Banking it would rewind the session, so leave the anchor alone.
  const ran = Math.floor((now - anchor) / 1000);
  if (ran <= 0) return timer;
  return {
    ...timer,
    accumulatedSeconds: Math.max(0, timer.accumulatedSeconds) + ran,
    lastStartedAt: new Date(anchor + ran * 1000).toISOString(),
  };
}

/** Stop the clock, keeping every second that was actually run. */
export function pauseFocusTimer(timer: FocusTimerState, now = Date.now()): FocusTimerState {
  return {
    ...checkpointFocusTimer(timer, now),
    isRunning: false,
    lastStartedAt: null,
    lastPausedAt: new Date(now).toISOString(),
  };
}

export function formatFocusDuration(seconds: number): string {
  const totalMinutes = Math.floor(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

export function formatCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(clamped / 60);
  const secs = clamped % 60;
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function sumFocusSecondsForDay(sessions: FocusSession[], day: Date, dayStartHour = 0): number {
  const key = dateKey(day);
  return sessions
    .filter(session => focusDayKey(session.endedAt, dayStartHour) === key)
    .reduce((sum, session) => sum + session.durationSeconds, 0);
}

export function parseDurationInput(str: string): number {
  const cleaned = str.trim().toLowerCase();
  if (!cleaned || cleaned === '0' || cleaned === '—' || cleaned === '-' || cleaned === 'none' || cleaned === 'clear' || cleaned === '0m' || cleaned === '0h' || cleaned === '0s') {
    return 0;
  }

  // hh:mm:ss or hh:mm
  if (cleaned.includes(':')) {
    const parts = cleaned.split(':').map(p => parseFloat(p) || 0);
    if (parts.length === 3) {
      return Math.max(0, Math.round(parts[0] * 3600 + parts[1] * 60 + parts[2]));
    }
    if (parts.length === 2) {
      return Math.max(0, Math.round(parts[0] * 3600 + parts[1] * 60));
    }
  }

  // Match patterns like "2h 30m", "2h30", "2 hours 30 mins", "2 hr 30", "2h", "45m"
  const hMatch = cleaned.match(/([\d.]+)\s*(?:hours?|hrs?|h)\b/i) || cleaned.match(/^([\d.]+)\s*h/i);
  const mMatch = cleaned.match(/([\d.]+)\s*(?:minutes?|mins?|m)\b/i) || cleaned.match(/[\s,]+([\d.]+)\s*m/i);
  const trailingMinsMatch = cleaned.match(/(?:hours?|hrs?|h)\s*([\d.]+)(?!\s*[a-z])/i);

  if (hMatch || mMatch || trailingMinsMatch) {
    let totalSec = 0;
    if (hMatch) {
      totalSec += Math.round(parseFloat(hMatch[1]) * 3600);
    }
    if (mMatch) {
      totalSec += Math.round(parseFloat(mMatch[1]) * 60);
    } else if (trailingMinsMatch) {
      totalSec += Math.round(parseFloat(trailingMinsMatch[1]) * 60);
    }
    return Math.max(0, totalSec);
  }

  // Decimal number e.g. "1.5" -> 1.5 hours
  if (cleaned.includes('.')) {
    const hours = parseFloat(cleaned);
    return isNaN(hours) || hours <= 0 ? 0 : Math.max(0, Math.round(hours * 3600));
  }

  // Pure integer number
  const num = parseInt(cleaned, 10);
  if (isNaN(num) || num <= 0) return 0;
  if (num <= 12) {
    return num * 3600; // e.g. 6 -> 6 hours
  } else {
    return num * 60;   // e.g. 45 -> 45 minutes
  }
}

export function formatDetailedDuration(seconds: number): string {
  if (seconds <= 0) return '0 minutes (Cleared)';
  const totalMins = Math.round(seconds / 60);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;

  if (hours > 0 && mins > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'}, ${mins} minute${mins === 1 ? '' : 's'} (${totalMins} mins total)`;
  } else if (hours > 0) {
    return `${hours} hour${hours === 1 ? '' : 's'} (${totalMins} mins total)`;
  } else {
    return `${mins} minute${mins === 1 ? '' : 's'}`;
  }
}

/**
 * Creates a FocusSession record for a manual day edit.
 * Ensures the generated session's endedAt timestamp falls cleanly on the specified focus day
 * under any focusDayStartHour (0-23) and in any timezone.
 */
export function createManualFocusSession(dateKeyVal: string, newSeconds: number, focusDayStartHour = 0): FocusSession {
  const parts = dateKeyVal.split('-').map(Number);
  const y = parts[0] || new Date().getFullYear();
  const m = (parts[1] || 1) - 1;
  const d = parts[2] || 1;

  // Local target hour safely within the focus day window
  const targetHour = Math.min(23, Math.max(0, focusDayStartHour + 6));
  const endDate = new Date(y, m, d, targetHour, 0, 0, 0);
  const endIso = endDate.toISOString();
  const startIso = new Date(endDate.getTime() - newSeconds * 1000).toISOString();

  return {
    id: `manual-${dateKeyVal}-${Date.now()}-${newSeconds}`,
    startedAt: startIso,
    endedAt: endIso,
    durationSeconds: newSeconds,
    plannedSeconds: newSeconds,
  };
}

