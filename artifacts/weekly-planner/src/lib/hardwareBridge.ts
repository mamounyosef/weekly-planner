// ---------------------------------------------------------------------------
// ESP32 focus-timer controller bridge logic.
//
// The firmware holds no logic at all: it posts raw button edges and
// raw ultrasonic centimetres, and renders whatever display state it is
// handed. Presence is decided here, by the shared filter in
// src/lib/sensorFilter.ts -- on the PC, where the analysis can be as
// involved as it needs to be and can be tested without a board on the
// desk. The windows then consume presence events and drive the session
// through the app's own start/pause/terminate code, so a hardware
// button and an on-screen button cannot ever behave differently.
//
// All of this is live, disposable state regenerated every second, so
// it stays in memory -- writing it to disk would just churn the file
// database for no benefit.
// ---------------------------------------------------------------------------

import { createPresenceFilter, coerceSensorFilterConfig, PresenceFilter, type SensorFilterConfig } from './sensorFilter';

export const HW_LEASE_MS = 6000;

export interface HardwareEvent {
  id: number;
  type: string;
  present?: boolean;
  distanceCm?: number;
  at: number;
}

/**
 * The sensor's standing verdict, as opposed to the moment it changed.
 *
 * WHY THIS EXISTS. Presence used to reach the controller only as edges: one
 * event per change, discarded if older than ten seconds, plus a single
 * announcement on a window's very first poll. Every one of those can be missed
 * -- a window that opens a moment before the filter warms up, a poll delayed
 * past the staleness cutoff, a lease moving between windows -- and when one is
 * missed there is NOTHING that ever puts it right. The controller sits
 * believing the desk is empty while the sensor plainly says otherwise, and no
 * amount of sitting there will start a session, because sitting still is not an
 * edge. Measured on this desk: thirty-eight minutes of the filter reporting
 * `present: true` against a controller stuck on `present: false`.
 *
 * A level can be compared. Handed the current verdict on every poll, the
 * controller can notice it disagrees and correct itself, which is the one thing
 * an edge stream can never do.
 */
export interface PresenceLevel {
  present: boolean;
  /** False while the filter is still warming up; its verdict means nothing yet. */
  ready: boolean;
  /** When the board last reported. Silence means the sensor, not the desk. */
  at: number;
}

export interface HardwareBridgeOptions {
  now?: () => number;
  filter?: PresenceFilter;
  leaseMs?: number;
}

export interface HardwareBridgeResponse {
  status: number;
  body: Record<string, unknown>;
}

function parseObject(raw: unknown): Record<string, unknown> {
  let parsed = raw;
  if (typeof raw === 'string') {
    if (!raw.trim()) throw new Error('empty body');
    parsed = JSON.parse(raw);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('expected object');
  }
  return parsed as Record<string, unknown>;
}

export class HardwareBridge {
  readonly now: () => number;
  readonly leaseMs: number;
  readonly hwFilter: PresenceFilter;

  hwEvents: HardwareEvent[] = [];
  hwEventSeq = 0;

  // What the ESP32's LCD should show. Pushed by whichever window owns the
  // controller, so the LCD renders the app's own numbers rather than a
  // second, independently-computed version of them.
  hwDisplay: Record<string, unknown> = {
    mode: 'idle',
    remainingSeconds: 0,
    todaySeconds: 0,
    sessionsToday: 0,
    armSeconds: 0,
  };
  hwDisplayAt = 0;

  // Both windows poll the same events. Without arbitration a single
  // button press would be acted on twice -- started by one window and
  // immediately paused by the other. A short lease makes exactly one
  // window the owner, and lets the widget take over within seconds if the
  // main window is closed.
  hwOwner: string | null = null;
  hwOwnerAt = 0;

  // Sensor tuning, owned by the app's settings and fetched by the board.
  // Keeping it here rather than in firmware means the thresholds and
  // filter parameters can be changed without plugging the ESP32 into the
  // PC to reflash it. Defaults match the firmware's own fallbacks.
  hwConfig: Record<string, unknown> = {
    ...coerceSensorFilterConfig(null),
    sampleIntervalMs: 100,
    calibrating: false,
    announceOnConnect: true,
  };

  // Latest readout, for the settings page. Every number here comes out
  // of the filter rather than off the wire, so what the page shows is
  // what the decision was actually made on.
  hwLiveDistance: number | null = null;
  hwLiveRaw: number | null = null;
  hwLivePresent = false;
  hwLiveDiagnostics: Record<string, unknown> = {};
  hwLiveBtnA = 1;
  hwLiveBtnB = 1;
  hwLiveEdgesA = 0;
  hwLiveEdgesB = 0;
  hwLiveDiag: Record<string, unknown> = {};
  hwLiveAt = 0;
  hwLastAnnounceAt = 0;

  // A short trail of what the controller actually decided and why. Two
  // bugs here were diagnosed by guesswork and the guesses were wrong;
  // this makes the sequence inspectable after the fact instead.
  //
  // TWO RINGS, on purpose. The firmware also posts raw pin edges here, and on a
  // desk with electrically noisy buttons it posts thousands of them: a single
  // shared ring filled with edge chatter within seconds and pushed out every
  // decision the log exists to record. Asked for the log after a session
  // started at the wrong moment, it could only say which pins had wobbled.
  hwLog: Array<Record<string, unknown>> = [];
  hwEdgeLog: Array<Record<string, unknown>> = [];

  // The controller's own state (are you here, is a countdown pending, how
  // long have you been away). This lives on the server rather than in a
  // window because it has to outlive both: a page reload or the lease
  // moving to the widget would otherwise lose the fact that you walked
  // away, so the session would neither terminate nor resume.
  hwController: Record<string, unknown> = {
    present: false,
    armingUntil: null,
    awaySince: null,
    stoppedByHand: false,
    sessionActive: false,
    manualSession: false,
    pausedByAway: false,
  };

  constructor(opts: HardwareBridgeOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.leaseMs = opts.leaseMs ?? HW_LEASE_MS;
    this.hwFilter = opts.filter ?? createPresenceFilter();
  }

  // --- ESP32 -> server: a button was pressed, or presence changed ---
  handleEvent(rawBody: unknown, now = this.now()): HardwareBridgeResponse {
    try {
      const parsed = parseObject(rawBody);
      const type = String(parsed?.type ?? '');
      if (!type) throw new Error('missing type');

      // A batch of raw pings. Not queued as events: the queue is for
      // decisions, and these are the evidence a decision gets made
      // from. They go straight into the filter, which is the only
      // thing on either side of the link that knows what they mean.
      if (type === 'samples') {
        const dt = Math.max(20, Math.min(5000, Number(parsed?.dt) || 100));
        const raw: unknown[] = Array.isArray(parsed?.cm) ? parsed.cm : [];

        // Timestamps are reconstructed backwards from arrival rather
        // than taken from the board's millis(): the two clocks share no
        // epoch, and the board's would have to be re-synchronised after
        // every reset. Network jitter shifts the whole batch by a few
        // ms, which no dwell time here can notice.
        let snap = this.hwFilter.snapshot;
        const n = raw.length;
        for (let i = 0; i < n; i++) {
          const v = Number(raw[i]);
          const at = now - (n - 1 - i) * dt;
          snap = this.hwFilter.push(Number.isFinite(v) && v > 0 ? v : null, at);
          // Emitted from inside the loop so a change that happened
          // three samples into the batch is reported at the moment it
          // happened, not at the end of the batch.
          if (snap.changed && snap.ready) {
            this.hwEvents.push({
              id: ++this.hwEventSeq,
              type: 'presence',
              present: snap.present,
              distanceCm: snap.distanceCm ?? undefined,
              at,
            });
            while (this.hwEvents.length > 50) this.hwEvents.shift();
          }
        }

        if (n > 0) {
          this.hwLiveDistance = snap.distanceCm;
          this.hwLiveRaw = snap.rawCm;
          this.hwLivePresent = snap.present;
          this.hwLiveDiagnostics = {
            ready: snap.ready,
            rawKind: snap.rawKind,
            support: Math.round(snap.support * 100) / 100,
            spreadCm: Math.round(snap.spreadCm * 10) / 10,
            nearRatio: Math.round(snap.nearRatio * 100) / 100,
            overRatio: Math.round(snap.overRatio * 100) / 100,
            masked: snap.masked,
            holding: snap.holding,
            holdingMs: Math.round(snap.holdingMs),
            awayProgressMs: Math.round(snap.awayProgressMs),
            awayNeedsMs: Math.round(snap.awayNeedsMs),
            arriveProgressMs: Math.round(snap.arriveProgressMs),
            arriveNeedsMs: Math.round(snap.arriveNeedsMs),
            windowCount: snap.windowCount,
            everEchoed: snap.everEchoed,
            forced: snap.forced,
          };
        }

        this.hwLiveBtnA = Number(parsed?.btnA);
        this.hwLiveBtnB = Number(parsed?.btnB);
        this.hwLiveEdgesA = Number(parsed?.edgesA);
        this.hwLiveEdgesB = Number(parsed?.edgesB);
        this.hwLiveDiag = {
          host: String(parsed?.host ?? ''),
          pollCode: Number(parsed?.pollCode),
          uiMode: String(parsed?.uiMode ?? ''),
          uiValid: Boolean(parsed?.uiValid),
        };
        this.hwLiveAt = now;
        return { status: 200, body: { success: true } };
      }

      const evt: HardwareEvent = { id: ++this.hwEventSeq, type, at: now };
      if (typeof parsed.present === 'boolean') evt.present = parsed.present;
      if (Number.isFinite(Number(parsed.distanceCm))) evt.distanceCm = Number(parsed.distanceCm);

      this.hwEvents.push(evt);
      // Unconsumed events are worthless once stale, and the queue must
      // not grow without bound if no window is open to drain it.
      while (this.hwEvents.length > 50) this.hwEvents.shift();

      return { status: 200, body: { success: true, id: evt.id } };
    } catch (_) {
      return { status: 400, body: { error: 'Bad hardware event' } };
    }
  }

  // --- app -> server: drain events newer than the last one seen ---
  getEvents(since: number, isAuthed: boolean, now = this.now()): HardwareBridgeResponse {
    if (!isAuthed) {
      return { status: 200, body: { events: [], latest: 0 } };
    }
    const sinceNum = Number(since) || 0;
    const resultEvents = this.hwEvents.filter(e => e.id > sinceNum);
    const snap = this.hwFilter.snapshot;
    const result = {
      events: resultEvents,
      latest: this.hwEventSeq,
      // Sent on EVERY poll, not only on change: this is what lets a controller
      // that missed an edge put itself right. See PresenceLevel above.
      presence: {
        present: snap.present,
        ready: snap.ready,
        at: this.hwLiveAt,
      } satisfies PresenceLevel,
    };

    // since=0 is a window opening for the first time. It deliberately
    // does not replay the backlog (acting on a ten-minute-old presence
    // change would pause a session that is running fine), so a desk
    // that was already occupied before the PC finished booting would
    // otherwise start nothing until you got up and sat back down.
    // Queued *after* responding, so the newcomer picks it up on its
    // next poll rather than in the batch it is about to discard.
    const announce = Boolean(this.hwConfig.announceOnConnect);
    const nowAt = now;
    if (sinceNum === 0 && announce && this.hwFilter.snapshot.ready && nowAt - this.hwLastAnnounceAt > 10000) {
      this.hwLastAnnounceAt = nowAt;
      this.hwEvents.push({
        id: ++this.hwEventSeq,
        type: 'presence',
        present: this.hwFilter.snapshot.present,
        distanceCm: this.hwFilter.snapshot.distanceCm ?? undefined,
        at: nowAt,
      });
      while (this.hwEvents.length > 50) this.hwEvents.shift();
    }
    return { status: 200, body: result };
  }

  // --- ESP32 <- server: what to draw on the LCD ---
  getState(now = this.now()): HardwareBridgeResponse {
    // A display that stopped being refreshed means no window is driving
    // the controller, which the firmware shows as "not working".
    const fresh = now - this.hwDisplayAt < this.leaseMs;
    const body = fresh
      ? this.hwDisplay
      : { mode: 'offline', remainingSeconds: 0, todaySeconds: 0, sessionsToday: 0, armSeconds: 0 };
    return { status: 200, body };
  }

  // --- app -> server: publish the numbers the LCD should mirror ---
  postState(rawBody: unknown, now = this.now()): HardwareBridgeResponse {
    try {
      const parsed = parseObject(rawBody);
      this.hwDisplay = {
        mode: ['idle', 'arming', 'running', 'paused'].includes(String(parsed?.mode)) ? String(parsed.mode) : 'idle',
        remainingSeconds: Math.max(0, Math.floor(Number(parsed?.remainingSeconds) || 0)),
        todaySeconds: Math.max(0, Math.floor(Number(parsed?.todaySeconds) || 0)),
        sessionsToday: Math.max(0, Math.floor(Number(parsed?.sessionsToday) || 0)),
        armSeconds: Math.max(0, Math.floor(Number(parsed?.armSeconds) || 0)),
      };
      this.hwDisplayAt = now;
      return { status: 200, body: { success: true } };
    } catch (_) {
      return { status: 400, body: { error: 'Bad hardware state' } };
    }
  }

  // --- ESP32 <- server: sensor tuning to apply at runtime ---
  getConfig(): HardwareBridgeResponse {
    return { status: 200, body: this.hwConfig };
  }

  // --- app -> server: publish sensor tuning from settings ---
  postConfig(rawBody: unknown): HardwareBridgeResponse {
    try {
      const parsed = parseObject(rawBody);
      // Already validated and clamped by coerceHardwareSettings before
      // being sent; stored as-is so the firmware sees exactly what the
      // settings page shows.
      const filterCfg = coerceSensorFilterConfig(parsed as Partial<SensorFilterConfig>);
      this.hwConfig = {
        ...filterCfg,
        sampleIntervalMs: Math.max(40, Math.min(2000, Number(parsed?.sampleIntervalMs) || 100)),
        calibrating: Boolean(parsed?.calibrating),
        announceOnConnect: Boolean(parsed?.announceOnConnect),
      };
      // Applied live. The readings already in the window stay -- they
      // are still true -- but every dwell timer restarts, since a timer
      // part-way to expiry was counting against a rule that has gone.
      this.hwFilter.configure(filterCfg);
      return { status: 200, body: { success: true } };
    } catch (_) {
      return { status: 400, body: { error: 'Bad hardware config' } };
    }
  }

  // --- app <- server: latest sensor reading ---
  getLive(now = this.now()): HardwareBridgeResponse {
    const fresh = now - this.hwLiveAt < 4000;
    return {
      status: 200,
      body: {
        // The believed distance, i.e. the dominant cluster's centre --
        // this is the number the decision was actually made on. rawCm is
        // the last unprocessed ping alongside it, so a placement problem
        // (the raw number thrashing) reads differently from a threshold
        // problem (a steady raw number on the wrong side of the line).
        distanceCm: fresh ? this.hwLiveDistance : null,
        rawCm: fresh ? this.hwLiveRaw : null,
        present: fresh ? this.hwLivePresent : null,
        filter: fresh ? this.hwLiveDiagnostics : null,
        btnA: fresh ? this.hwLiveBtnA : null,
        btnB: fresh ? this.hwLiveBtnB : null,
        edgesA: fresh ? this.hwLiveEdgesA : null,
        edgesB: fresh ? this.hwLiveEdgesB : null,
        diag: fresh ? this.hwLiveDiag : null,
        fresh,
        ageMs: this.hwLiveAt ? now - this.hwLiveAt : null,
      },
    };
  }

  // --- decision trail, for diagnosing the controller after the fact ---
  postLog(rawBody: unknown, now = this.now()): HardwareBridgeResponse {
    try {
      const parsed = parseObject(rawBody);
      const entry = { at: now, ...parsed };
      // Raw pin wobble from the firmware goes in its own ring. On this desk the
      // buttons emit thousands of spurious edges, which filled a single shared
      // ring in seconds and left the log unable to answer the only question it
      // is ever asked: why did the controller do that.
      const ring = parsed.source === 'edge' ? this.hwEdgeLog : this.hwLog;
      ring.push(entry);
      while (ring.length > 200) ring.shift();
      return { status: 200, body: { success: true } };
    } catch (_) {
      return { status: 400, body: { error: 'Bad log entry' } };
    }
  }

  getLog(): HardwareBridgeResponse {
    return { status: 200, body: { entries: this.hwLog, edges: this.hwEdgeLog } };
  }

  // --- controller state, shared across windows and reloads ---
  getController(): HardwareBridgeResponse {
    return { status: 200, body: this.hwController };
  }

  postController(rawBody: unknown): HardwareBridgeResponse {
    try {
      const parsed = parseObject(rawBody);
      // Must test the value itself, not Number(value): Number(null) is
      // 0, which is finite, so "no timer set" came back as a timestamp
      // in 1970 -- instantly older than any timeout, which terminated
      // sessions the moment they paused.
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);
      this.hwController = {
        present: Boolean(parsed?.present),
        armingUntil: num(parsed?.armingUntil),
        awaySince: num(parsed?.awaySince),
        stoppedByHand: Boolean(parsed?.stoppedByHand),
        // Whitelisted explicitly, so anything added to the controller
        // state must be added here too -- these three were the ones
        // that silently vanished on every reload and lease hand-off.
        sessionActive: Boolean(parsed?.sessionActive),
        manualSession: Boolean(parsed?.manualSession),
        pausedByAway: Boolean(parsed?.pausedByAway),
      };
      return { status: 200, body: { success: true } };
    } catch (_) {
      return { status: 400, body: { error: 'Bad controller state' } };
    }
  }

  // --- app: which window owns the controller right now? ---
  claim(key: string, isAuthed: boolean, now = this.now()): HardwareBridgeResponse {
    if (!isAuthed) {
      return { status: 200, body: { owner: false } };
    }
    if (!this.hwOwner || this.hwOwner === key || now - this.hwOwnerAt > this.leaseMs) {
      this.hwOwner = key;
      this.hwOwnerAt = now;
      return { status: 200, body: { owner: true } };
    }
    return { status: 200, body: { owner: false } };
  }

  // --- /api/focus-timer/toggle: cancel pending arm countdown on hotkey toggle ---
  cancelArming(now = this.now()): boolean {
    const armingUntil = this.hwController.armingUntil;
    if (typeof armingUntil === 'number' && Number.isFinite(armingUntil) && armingUntil > now) {
      this.hwController = { ...this.hwController, armingUntil: null, stoppedByHand: true };
      this.hwEvents.push({ id: ++this.hwEventSeq, type: 'manual_stop', at: now });
      while (this.hwEvents.length > 50) this.hwEvents.shift();
      return true;
    }
    return false;
  }
}

export function createHardwareBridge(opts?: HardwareBridgeOptions): HardwareBridge {
  return new HardwareBridge(opts);
}
