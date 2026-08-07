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
   * When this state was written, in ms. Stamped by whichever window pushed it,
   * and used purely to reject STALE echoes: a burst of duration edits produces a
   * burst of pushes, and the broadcast of an earlier one can land after a later
   * one and drag the number backwards. Deliberately excluded from the identity,
   * push and cue keys — it is metadata about the write, not part of the state.
   */
  updatedAt?: number;
}

export const FOCUS_SESSIONS_KEY = 'planner-focus-sessions';
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

export type FocusChimeId = 'bowl' | 'marimba' | 'bell' | 'drops' | 'breath';

export const FOCUS_CHIMES: { id: FocusChimeId; label: string; hint: string }[] = [
  { id: 'bowl',    label: 'Singing bowl', hint: 'One low note that swells and fades. Calmest.' },
  { id: 'marimba', label: 'Marimba',      hint: 'Warm wooden triad. Short and friendly.' },
  { id: 'bell',    label: 'Soft bell',    hint: 'Struck bell with a long shimmer.' },
  { id: 'drops',   label: 'Water drops',  hint: 'Two rounded blips, very light.' },
  { id: 'breath',  label: 'Breath',       hint: 'Barely-there rising swell. Quietest.' },
];

export const DEFAULT_FOCUS_CHIME: FocusChimeId = 'bowl';

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
}

function tone(ctx: AudioContext, dest: AudioNode, o: ToneOpts): void {
  const t = ctx.currentTime + o.at;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t);
  if (o.detune) osc.detune.setValueAtTime(o.detune, t);
  if (o.glide) osc.frequency.exponentialRampToValueAtTime(o.freq * o.glide, t + o.dur);
  const attack = o.attack ?? 0.012;
  g.gain.setValueAtTime(0.00001, t);
  g.gain.exponentialRampToValueAtTime(o.peak, t + attack);
  // Real struck bodies decay along a curve, not a straight exponential to zero.
  // Two stages — a quick initial drop, then a long tail — is what reads as "rich".
  g.gain.exponentialRampToValueAtTime(o.peak * 0.32, t + attack + o.dur * 0.18);
  g.gain.exponentialRampToValueAtTime(0.00001, t + o.dur);
  osc.connect(g);
  if (o.pan !== undefined && typeof ctx.createStereoPanner === 'function') {
    const p = ctx.createStereoPanner();
    p.pan.value = o.pan;
    g.connect(p);
    p.connect(dest);
  } else {
    g.connect(dest);
  }
  osc.start(t);
  osc.stop(t + o.dur + 0.05);
}

// A small algorithmic room, rendered once and reused. Reverb is most of what
// separates "a beep" from something that sounds like it was recorded in a space.
let sharedIR: AudioBuffer | null = null;

function getReverbIR(ctx: AudioContext): AudioBuffer {
  if (sharedIR) return sharedIR;
  const seconds = 2.2;
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
function buildChain(ctx: AudioContext, cutoff = 3200): { master: GainNode; send: GainNode } {
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
    verbTone.frequency.value = 2200;
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
    let wetAmount = 0.3;

    switch (coerceFocusChime(id)) {
      case 'marimba': {
        // Warm major triad, struck in quick succession. Marimba bars ring an
        // octave-plus-a-fifth above the fundamental, which is what makes the
        // timbre read as wooden rather than as a plain sine.
        wetAmount = 0.22;
        [392.0, 493.9, 587.3].forEach((f, i) => {
          const at = i * 0.07;
          const pan = (i - 1) * 0.22;
          tone(ctx, master, { freq: f, at, dur: 0.62, peak: 0.15, attack: 0.004, pan });
          tone(ctx, master, { freq: f * 3.0, at, dur: 0.2, peak: 0.035, attack: 0.003, pan });
          tone(ctx, master, { freq: f * 6.0, at, dur: 0.09, peak: 0.012, attack: 0.002, pan });
        });
        break;
      }
      case 'bell': {
        // Struck bell. Real bells are inharmonic: hum an octave below, then the
        // prime, minor third, fifth and nominal — that ratio set is why this
        // sounds like metal instead of an organ.
        wetAmount = 0.45;
        const f = 523.25;
        const partials: [number, number, number][] = [
          // [ratio, peak, seconds]
          [0.5,  0.085, 3.2],
          [1.0,  0.14,  2.8],
          [1.19, 0.055, 2.0],
          [1.5,  0.045, 1.6],
          [2.0,  0.05,  1.5],
          [2.51, 0.022, 0.9],
          [3.01, 0.014, 0.6],
        ];
        partials.forEach(([ratio, peak, dur], i) => {
          tone(ctx, master, {
            freq: f * ratio, at: 0, dur, peak,
            attack: 0.004 + i * 0.001,
            detune: (i % 2 === 0 ? 1 : -1) * 2.5,
            pan: (i % 3 - 1) * 0.18,
          });
        });
        break;
      }
      case 'drops': {
        // Two rounded blips, each pitch-dropping like a droplet hitting water,
        // with a faint high sparkle on the tail of each.
        wetAmount = 0.38;
        tone(ctx, master, { freq: 880, at: 0,    dur: 0.38, peak: 0.12, attack: 0.005, glide: 0.7,  pan: -0.25 });
        tone(ctx, master, { freq: 1760, at: 0,   dur: 0.12, peak: 0.03, attack: 0.003, glide: 0.7,  pan: -0.25 });
        tone(ctx, master, { freq: 660, at: 0.2,  dur: 0.5,  peak: 0.1,  attack: 0.005, glide: 0.74, pan: 0.25 });
        tone(ctx, master, { freq: 1320, at: 0.2, dur: 0.14, peak: 0.024, attack: 0.003, glide: 0.74, pan: 0.25 });
        break;
      }
      case 'breath': {
        // Slow swell on a perfect fifth, doubled with a few cents of detune so it
        // shimmers instead of sitting still. Quietest option by some margin.
        wetAmount = 0.5;
        tone(ctx, master, { freq: 329.6, at: 0,    dur: 2.0, peak: 0.07,  attack: 0.4,  pan: -0.2 });
        tone(ctx, master, { freq: 329.6, at: 0,    dur: 2.0, peak: 0.045, attack: 0.45, detune: 6, pan: 0.2 });
        tone(ctx, master, { freq: 493.9, at: 0.14, dur: 1.9, peak: 0.05,  attack: 0.5,  pan: 0.25 });
        tone(ctx, master, { freq: 659.3, at: 0.28, dur: 1.6, peak: 0.022, attack: 0.55, pan: -0.25 });
        break;
      }
      case 'bowl':
      default: {
        // Singing bowl: low fundamental with a beating partner a few cents away
        // (that slow throb is the signature of a real bowl), a fifth above, and a
        // faint shimmer on top. Long, slow, unhurried.
        wetAmount = 0.5;
        tone(ctx, master, { freq: 261.6, at: 0,    dur: 3.4, peak: 0.15,  attack: 0.07, pan: -0.15 });
        tone(ctx, master, { freq: 261.6, at: 0,    dur: 3.2, peak: 0.09,  attack: 0.09, detune: 7, pan: 0.15 });
        tone(ctx, master, { freq: 392.0, at: 0.03, dur: 2.8, peak: 0.06,  attack: 0.11, pan: 0.22 });
        tone(ctx, master, { freq: 654.0, at: 0.06, dur: 2.0, peak: 0.025, attack: 0.14, pan: -0.22 });
        tone(ctx, master, { freq: 784.0, at: 0.06, dur: 1.6, peak: 0.016, attack: 0.16, pan: 0.1 });
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
  resume: 'pebble',
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
  return `${t.isRunning}|${t.sessionStartedAt ?? ''}|${t.lastStartedAt ?? ''}|${t.lastPausedAt ?? ''}|${t.accumulatedSeconds}`;
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
