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
}

export const FOCUS_SESSIONS_KEY = 'planner-focus-sessions';
export const FOCUS_TIMER_KEY = 'planner-focus-timer';
export const MIN_COMPLETED_SESSION_SECONDS = 20 * 60;

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

function getCtx(): AudioContext | null {
  try {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    if (!sharedCtx) sharedCtx = new AC();
    if (sharedCtx.state === 'suspended') sharedCtx.resume().catch(() => {});
    return sharedCtx;
  } catch (_) {
    return null;
  }
}

/**
 * Open (and unlock) the audio context on a user gesture. Browsers won't let a
 * page make sound until one happens, and doing it up front means the chime is
 * instant when the session actually ends.
 */
export function primeFocusAudio(): void {
  const ctx = getCtx();
  if (!ctx) return;
  // A silent blip is enough to move the context out of "suspended".
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

export function playFocusChime(id: FocusChimeId = DEFAULT_FOCUS_CHIME): void {
  const ctx = getCtx();
  if (!ctx) return;
  try {
    // Master chain: dry level → gentle lowpass → out, with a parallel reverb send.
    // The lowpass takes the glassy edge off; the reverb is what gives the sound
    // depth instead of the flat "computer beep" quality of the old version.
    const master = ctx.createGain();
    master.gain.value = 0.5;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 3200;
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

    let wetAmount = 0.3;
    const send = ctx.createGain();
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
    } catch (_) {
      wetAmount = 0; // no convolver support — dry only
    }

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

export const DEFAULT_FOCUS_TIMER: FocusTimerState = {
  plannedSeconds: 60 * 60,
  accumulatedSeconds: 0,
  isRunning: false,
  lastStartedAt: null,
  sessionStartedAt: null,
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
  };
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
  const runningSeconds = timer.isRunning && timer.lastStartedAt
    ? Math.max(0, Math.floor((now - new Date(timer.lastStartedAt).getTime()) / 1000))
    : 0;
  return Math.max(0, Math.floor(timer.accumulatedSeconds + runningSeconds));
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
