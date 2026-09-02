// ─── Doing expensive work once instead of once per keystroke ─────────────────
// Two things on the phone were being redone on EVERY edit, in full:
//
//   • the alarm plan — `computeSchedule` across every event and task, then a
//     native round trip to read back what the OS currently holds, then a
//     schedule or cancel per changed alarm;
//   • the durable copy of the whole planner state — a JSON.stringify of very
//     nearly a megabyte.
//
// Neither is wrong once. Both are wrong nine times while a finger drags an
// event across an hour, and that is exactly when the app most needs the frame
// budget it is spending on them.
//
// A coalescer is the smallest thing that fixes it: remember only the LATEST
// request, do the work after a short quiet period, and never run two at once.
//
// THE RULES IT HAS TO KEEP, because sync correctness rests on them:
//
//   • the newest payload always wins — never a stale one that happened to be
//     mid-flight when a newer request arrived;
//   • work requested during a run is not lost; it runs again afterwards;
//   • `maxWaitMs` bounds the delay even under a request every few milliseconds,
//     so a long drag cannot postpone a save indefinitely;
//   • `flush()` runs the pending work NOW and resolves only when everything is
//     genuinely finished, so backgrounding the app is a safe moment;
//   • a throw is reported and forgotten. A failed alarm plan must never stop
//     the next one from being attempted.

export interface Coalescer<T> {
  /** Ask for the work to be done, eventually, with this payload. */
  schedule(payload: T): void;
  /** Do it now if anything is pending, and wait until it is truly done. */
  flush(): Promise<void>;
  /** Forget anything pending. Does not interrupt a run already in progress. */
  cancel(): void;
  /** True while a run is in progress or a payload is waiting. */
  busy(): boolean;
  /** Wait for an in-flight run without starting a new one. */
  settled(): Promise<void>;
}

export interface CoalesceOptions<T> {
  /** Quiet period before the work runs. */
  delayMs: number;
  /**
   * Upper bound on how long a payload may wait, however many requests arrive.
   * Without it, a continuous stream of edits postpones the work forever.
   */
  maxWaitMs?: number;
  run(payload: T): Promise<void> | void;
  onError?(err: unknown): void;
  /** Injected so the tests do not have to wait in real time. */
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(handle: unknown): void;
  now?(): number;
}

export function createCoalescer<T>(opts: CoalesceOptions<T>): Coalescer<T> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as any));
  const now = opts.now ?? (() => Date.now());

  let timer: unknown = null;
  let hasPending = false;
  let pending: T | undefined;
  /** When the oldest still-unrun request arrived, for the maxWait bound. */
  let oldestAt = 0;
  let running: Promise<void> | null = null;

  const report = (err: unknown) => {
    try { opts.onError?.(err); } catch { /* a logger must not throw */ }
  };

  function stopTimer(): void {
    if (timer !== null) { clearTimer(timer); timer = null; }
  }

  function startTimer(ms: number): void {
    stopTimer();
    timer = setTimer(() => { timer = null; void fire(); }, Math.max(0, ms));
  }

  /** Run the pending payload, then anything that arrived while it ran. */
  async function fire(): Promise<void> {
    if (running) return;               // the tail below will pick it up
    if (!hasPending) return;

    const payload = pending as T;
    hasPending = false;
    pending = undefined;
    stopTimer();

    running = (async () => {
      try {
        await opts.run(payload);
      } catch (err) {
        report(err);
      }
    })();

    try {
      await running;
    } finally {
      running = null;
    }

    // Something asked again while we were busy: do it, without waiting out
    // another quiet period. It has already waited for a whole run.
    if (hasPending) await fire();
  }

  return {
    schedule(payload: T): void {
      const at = now();
      if (!hasPending) oldestAt = at;
      hasPending = true;
      pending = payload;

      if (running) return;             // the tail of `fire` will handle it

      const wait = opts.delayMs;
      if (typeof opts.maxWaitMs === 'number') {
        const remaining = opts.maxWaitMs - (at - oldestAt);
        startTimer(Math.min(wait, Math.max(0, remaining)));
        return;
      }
      startTimer(wait);
    },

    async flush(): Promise<void> {
      stopTimer();
      // Await any run already going before starting ours, so `flush` cannot
      // interleave two writes of the same state.
      if (running) await running;
      if (hasPending) await fire();
      // A run started by a timer that fired between the two awaits above.
      if (running) await running;
    },

    cancel(): void {
      stopTimer();
      hasPending = false;
      pending = undefined;
    },

    busy(): boolean {
      return hasPending || running !== null;
    },

    async settled(): Promise<void> {
      if (running) await running;
    },
  };
}
