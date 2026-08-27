/**
 * Keeps the public link alive.
 *
 * The planner is reachable from the phone through a Tailscale Funnel that
 * proxies https://<node>.ts.net to this dev server. That mapping is stored by
 * tailscaled, not by us, and it can be lost: a Tailscale update, a re-login, a
 * service restart, or someone running `tailscale serve reset` all silently
 * take the public link down. Nothing in the app notices, and the first symptom
 * is the phone failing to sign in, which is exactly what happened once and cost
 * a day of guessing.
 *
 * So the dev server now watches its own front door. Every few minutes it asks
 * tailscaled whether the funnel is on and pointed at this port, and if it is
 * not, it puts it back. Every check and every repair is appended to
 * database/funnel-watchdog.log, so the history is on disk rather than in a
 * terminal nobody was looking at.
 *
 * Deliberately conservative: it only ever re-asserts the exact mapping it was
 * told to keep, it never turns the funnel off, and if the tailscale binary is
 * missing it disables itself after one line in the log rather than retrying
 * forever.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const CMD_TIMEOUT_MS = 20 * 1000;

/** Where tailscale lands on a default Windows install. */
const WINDOWS_TAILSCALE = 'C:\\Program Files\\Tailscale\\tailscale.exe';

function tailscaleBinary(): string | null {
  if (process.platform === 'win32') {
    return fs.existsSync(WINDOWS_TAILSCALE) ? WINDOWS_TAILSCALE : null;
  }
  return 'tailscale';
}

function run(bin: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(bin, args, { timeout: CMD_TIMEOUT_MS, windowsHide: true }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      const code = err ? ((err as any).code ?? 1) : 0;
      resolve({ code: typeof code === 'number' ? code : 1, out });
    });
  });
}

export interface FunnelWatchdogOptions {
  rootDir: string;
  /** The local port the funnel must point at. */
  port: number;
  intervalMs?: number;
  runner?: (bin: string, args: string[]) => Promise<{ code: number; out: string }>;
  tailscaleBinary?: () => string | null;
  log?: (line: string) => void;
}

export function createFunnelWatchdog(options: FunnelWatchdogOptions) {
  const { rootDir, port } = options;
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const logPath = path.join(rootDir, 'database', 'funnel-watchdog.log');
  const target = `http://127.0.0.1:${port}`;
  const runCmd = options.runner ?? run;
  const getTailscale = options.tailscaleBinary ?? tailscaleBinary;

  let timer: NodeJS.Timeout | null = null;
  let disabled = false;
  let lastState: string | null = null;
  let repairs = 0;
  let checkedAt = 0;

  const log = (line: string) => {
    if (options.log) {
      options.log(line);
      return;
    }
    const stamp = new Date().toISOString();
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      // Keep the file from growing without bound; this is a diary, not a record.
      try {
        if (fs.statSync(logPath).size > 256 * 1024) {
          const kept = fs.readFileSync(logPath, 'utf8').split('\n').slice(-500).join('\n');
          fs.writeFileSync(logPath, kept);
        }
      } catch { /* no file yet */ }
      fs.appendFileSync(logPath, `${stamp} ${line}\n`);
    } catch { /* logging must never take the server down */ }
  };

  /** True when tailscaled reports the funnel serving our port. */
  const isHealthy = (statusOut: string) =>
    /Funnel on/i.test(statusOut) && statusOut.includes(target);

  const check = async () => {
    if (disabled) return;
    const bin = getTailscale();
    if (!bin) {
      disabled = true;
      log('tailscale not installed on this machine; watchdog disabled');
      return;
    }



    checkedAt = Date.now();
    const status = await runCmd(bin, ['funnel', 'status']);
    if (isHealthy(status.out)) {
      if (lastState !== 'up') log(`funnel up, proxying ${target}`);
      lastState = 'up';
      return;
    }

    lastState = 'down';
    log(`funnel not serving ${target}; re-asserting. status was: ${status.out.trim().replace(/\s+/g, ' ').slice(0, 300)}`);

    const fix = await runCmd(bin, ['funnel', '--bg', '--https=443', target]);
    const after = await runCmd(bin, ['funnel', 'status']);

    if (isHealthy(after.out)) {
      repairs += 1;
      lastState = 'up';
      log('funnel restored');
    } else {
      log(`could not restore the funnel: ${(fix.out + ' ' + after.out).trim().replace(/\s+/g, ' ').slice(0, 300)}`);
    }
  };

  return {
    start() {
      if (timer) return;
      // Delayed: at boot tailscaled is often still coming up, and a check then
      // would report a failure that fixes itself a few seconds later.
      setTimeout(() => { void check(); }, FIRST_CHECK_DELAY_MS);
      timer = setInterval(() => { void check(); }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    kick: check,
    health: () => ({ disabled, state: lastState, repairs, checkedAt, target, logPath }),
  };
}
