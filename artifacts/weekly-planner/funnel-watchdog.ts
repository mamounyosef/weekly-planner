/**
 * Keeps the public link alive, and proves it from the outside.
 *
 * The planner is reachable from the phone and from other machines through a
 * Tailscale Funnel that proxies https://<node>.ts.net to this dev server. That
 * mapping is stored by tailscaled, not by us, and it can be lost: a Tailscale
 * update, a re-login, a service restart, or someone running `tailscale serve
 * reset` all silently take the public link down.
 *
 * THE LESSON OF 2026-09-09. The previous version of this file asked tailscaled
 * one question, "is the funnel on and pointed at my port?", and trusted the
 * answer. On 2026-09-09 tailscaled's backend fell into a bad state, the public
 * DNS record for the node stopped being published, and the link was dead from
 * the internet for eleven days. Throughout all eleven days `tailscale funnel
 * status` kept cheerfully answering "Funnel on", so this watchdog logged
 * "funnel up" once a day and never repaired anything. The phone stopped syncing
 * and nothing said why.
 *
 * So local configuration is no longer accepted as evidence. Health means a real
 * HTTPS request that leaves this machine, resolved through a PUBLIC resolver
 * (locally the name resolves to the 100.x tailnet address, so a fetch from here
 * can succeed while the outside world gets nothing) and sent to the public
 * ingress with the correct SNI. Anything less has already been proven to lie.
 *
 * The second lesson was that the repair was too weak. Re-asserting the funnel,
 * which is all this used to do, did NOT fix 2026-09-09. What fixed it was
 * resetting the serve config and restarting the Tailscale service. So repair is
 * now a ladder that escalates with consecutive failures, gentlest first, and
 * the harsh steps are reached only after the gentle ones have demonstrably
 * failed.
 *
 * The third lesson was propagation. After a successful repair the public DNS
 * record took several minutes to appear. Probing once immediately afterwards
 * reports failure for a repair that actually worked, which would escalate the
 * ladder for no reason and restart a perfectly healthy service. So after any
 * repair the watchdog enters a grace period and re-probes patiently instead of
 * judging immediately.
 *
 * Every check, repair and escalation is appended to
 * database/funnel-watchdog.log, so the history is on disk rather than in a
 * terminal nobody was looking at.
 */
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 20 * 1000;
const CMD_TIMEOUT_MS = 20 * 1000;
const PROBE_TIMEOUT_MS = 15 * 1000;

/**
 * How long to keep re-probing after a repair before calling it failed.
 *
 * Tailscale took minutes to publish the DNS record on 2026-09-09. Judging the
 * repair on a single immediate probe is what made a working fix look broken.
 */
const GRACE_MS = 4 * 60 * 1000;
const GRACE_PROBE_EVERY_MS = 30 * 1000;

/**
 * Consecutive failed checks before the user is told.
 *
 * The whole point of the rewrite is that nobody found out for eleven days. Two
 * strikes is roughly ten minutes, long enough that a rebuild or a brief network
 * blip does not cry wolf.
 */
const ALERT_AFTER_STRIKES = 2;

/** Where tailscale lands on a default Windows install. */
const WINDOWS_TAILSCALE = 'C:\\Program Files\\Tailscale\\tailscale.exe';
const WINDOWS_TAILSCALE_X86 = 'C:\\Program Files (x86)\\Tailscale\\tailscale.exe';

function tailscaleBinary(): string | null {
  if (process.platform === 'win32') {
    for (const p of [WINDOWS_TAILSCALE, WINDOWS_TAILSCALE_X86]) {
      if (fs.existsSync(p)) return p;
    }
    return null;
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

/** One rung of the repair ladder. */
export interface RepairStep {
  name: string;
  run: (ctx: RepairContext) => Promise<void>;
}

export interface RepairContext {
  exec: (bin: string, args: string[]) => Promise<{ code: number; out: string }>;
  bin: string;
  target: string;
  port: number;
  log: (line: string) => void;
}

/**
 * The ladder, gentlest first.
 *
 * Index N is used on the Nth consecutive failure; past the end it sticks on the
 * last rung rather than giving up, because "the harshest repair did not work"
 * is not a reason to stop trying (the cause may be a network outage that later
 * clears on its own).
 */
export const REPAIR_LADDER: RepairStep[] = [
  {
    name: 're-assert the funnel',
    async run({ exec, bin, target }) {
      await exec(bin, ['funnel', '--bg', '--https=443', target]);
    },
  },
  {
    name: 'reset the serve config and re-assert',
    async run({ exec, bin, target }) {
      await exec(bin, ['funnel', 'reset']);
      await exec(bin, ['serve', 'reset']);
      await exec(bin, ['funnel', '--bg', '--https=443', target]);
    },
  },
  {
    name: 'bring the tailscale backend up, then re-assert',
    async run({ exec, bin, target }) {
      await exec(bin, ['up']);
      await exec(bin, ['funnel', 'reset']);
      await exec(bin, ['funnel', '--bg', '--https=443', target]);
    },
  },
  {
    // This is what actually fixed 2026-09-09 after every gentler step had been
    // tried and failed. Restarting the service drops the tailnet for a few
    // seconds, which is why it is last and not first.
    name: 'restart the Tailscale service, then re-assert',
    async run({ exec, bin, target, log }) {
      const stop = await exec('net', ['stop', 'Tailscale']);
      if (stop.code !== 0) {
        log(`  could not stop the service (needs admin): ${oneLine(stop.out)}`);
      }
      await exec('net', ['start', 'Tailscale']);
      await exec(bin, ['up']);
      await exec(bin, ['funnel', 'reset']);
      await exec(bin, ['funnel', '--bg', '--https=443', target]);
    },
  },
];

function oneLine(s: string, max = 300): string {
  return String(s || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/** The node's public DNS name, e.g. "mamoun.tail27d0a5.ts.net". */
export function parseDnsName(statusJson: string): string | null {
  try {
    const data = JSON.parse(statusJson);
    const host = (data?.Self?.DNSName ?? '') as string;
    const trimmed = host.replace(/\.$/, '');
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export interface PublicProbe {
  ok: boolean;
  detail: string;
}

/**
 * Resolve a name through public DNS-over-HTTPS.
 *
 * Deliberately NOT the system resolver. On this machine Tailscale's own DNS
 * proxy answers with the 100.x tailnet address, so the system resolver cannot
 * distinguish "reachable from the internet" from "reachable from here", which
 * is precisely the distinction that matters.
 */
export async function resolvePublic(
  host: string,
  fetcher: typeof fetch,
): Promise<string[]> {
  const endpoints = [
    `https://dns.google/resolve?name=${encodeURIComponent(host)}&type=A`,
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
  ];
  for (const url of endpoints) {
    try {
      const res = await fetcher(url, {
        headers: { accept: 'application/dns-json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as any;
      const answers = Array.isArray(body?.Answer) ? body.Answer : [];
      // type 1 is an A record. Anything else (CNAME, SOA in a negative answer)
      // is not an address we can connect to.
      const ips = answers
        .filter((a: any) => a?.type === 1 && typeof a?.data === 'string')
        .map((a: any) => a.data as string);
      if (ips.length > 0) return ips;
      // A definitive empty answer from one resolver is worth confirming against
      // the other before believing it, so fall through rather than returning.
    } catch {
      // Try the next resolver. Both failing is reported by the caller as
      // "no public DNS record", which is also what a real outage looks like;
      // the distinction does not change the repair.
    }
  }
  return [];
}

export interface FunnelWatchdogOptions {
  rootDir: string;
  /** The local port the funnel must point at. */
  port: number;
  intervalMs?: number;
  graceMs?: number;
  runner?: (bin: string, args: string[]) => Promise<{ code: number; out: string }>;
  tailscaleBinary?: () => string | null;
  log?: (line: string) => void;
  /** Injected for tests; defaults to the global fetch. */
  fetcher?: typeof fetch;
  /** Injected for tests so the grace period does not really take minutes. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /**
   * Called when the link has been down for ALERT_AFTER_STRIKES checks running,
   * and again once it recovers. This is the part that means a future outage is
   * noticed in minutes instead of days.
   */
  onAlert?: (event: { down: boolean; detail: string; strikes: number }) => void;
  /** Probe an already-resolved address. Injected for tests. */
  probeAddress?: (ip: string, host: string) => Promise<PublicProbe>;
}

export function createFunnelWatchdog(options: FunnelWatchdogOptions) {
  const { rootDir, port } = options;
  const intervalMs = options.intervalMs ?? CHECK_INTERVAL_MS;
  const graceMs = options.graceMs ?? GRACE_MS;
  const logPath = path.join(rootDir, 'database', 'funnel-watchdog.log');
  const target = `http://127.0.0.1:${port}`;
  const runCmd = options.runner ?? run;
  const getTailscale = options.tailscaleBinary ?? tailscaleBinary;
  const fetcher = options.fetcher ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = options.now ?? (() => Date.now());

  let timer: NodeJS.Timeout | null = null;
  let disabled = false;
  let lastState: string | null = null;
  let lastDetail = '';
  let repairs = 0;
  let strikes = 0;
  let alerted = false;
  let checkedAt = 0;
  let running = false;

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

  /**
   * One real request through the public ingress.
   *
   * Any HTTP answer below 500 counts as healthy, 401 included: that is the
   * public password gate doing its job, and it proves the whole chain from the
   * internet to this dev server is intact.
   */
  const probeAddress = options.probeAddress ?? (async (ip: string, host: string): Promise<PublicProbe> => {
    // Import lazily so the module stays loadable in environments without TLS
    // sockets (tests inject their own probe and never reach this path).
    const tls = await import('tls');
    return new Promise<PublicProbe>(resolve => {
      let settled = false;
      const done = (ok: boolean, detail: string) => {
        if (settled) return;
        settled = true;
        try { socket.destroy(); } catch { /* already gone */ }
        resolve({ ok, detail });
      };
      const socket = tls.connect(
        { host: ip, port: 443, servername: host, timeout: PROBE_TIMEOUT_MS },
        () => {
          socket.write(
            `GET / HTTP/1.1\r\nHost: ${host}\r\nUser-Agent: planner-watchdog\r\n` +
            'Connection: close\r\n\r\n',
          );
        },
      );
      socket.setTimeout(PROBE_TIMEOUT_MS, () => done(false, 'timeout'));
      socket.on('data', chunk => {
        const head = chunk.toString('utf8', 0, 64);
        const m = /^HTTP\/1\.[01] (\d{3})/.exec(head);
        if (!m) return done(false, `unexpected answer: ${oneLine(head, 60)}`);
        const code = Number(m[1]);
        done(code < 500, `HTTP ${code}`);
      });
      socket.on('error', err => done(false, `${(err as any)?.code ?? 'error'}`));
      socket.on('end', () => done(false, 'closed with no answer'));
    });
  });

  /** The authoritative health question: can the outside world reach us? */
  const publicCheck = async (host: string): Promise<PublicProbe> => {
    const ips = await resolvePublic(host, fetcher);
    if (ips.length === 0) return { ok: false, detail: 'no public DNS record' };
    let lastFail = 'unreachable';
    for (const ip of ips) {
      const probe = await probeAddress(ip, host);
      // One healthy ingress is enough: Tailscale publishes several and a client
      // only needs one of them to answer.
      if (probe.ok) return probe;
      lastFail = `${ip}: ${probe.detail}`;
    }
    return { ok: false, detail: lastFail };
  };

  /**
   * Re-probe patiently after a repair.
   *
   * Returns as soon as it is healthy. A repair that needs four minutes to show
   * up is still a repair that worked, and treating it as a failure is what
   * would escalate to restarting a service that did not need restarting.
   */
  const waitForRecovery = async (host: string): Promise<PublicProbe> => {
    const deadline = now() + graceMs;
    let probe = await publicCheck(host);
    while (!probe.ok && now() < deadline) {
      await sleep(GRACE_PROBE_EVERY_MS);
      probe = await publicCheck(host);
    }
    return probe;
  };

  const check = async () => {
    if (disabled) return;
    // The grace period can outlast the interval. Overlapping checks would fight
    // over the repair ladder and double-count strikes.
    if (running) return;
    running = true;
    try {
      const bin = getTailscale();
      if (!bin) {
        disabled = true;
        log('tailscale not installed on this machine; watchdog disabled');
        return;
      }

      checkedAt = now();

      const status = await runCmd(bin, ['status', '--json']);
      const host = parseDnsName(status.out);
      if (!host) {
        // No name means tailscaled is not answering at all, which the ladder's
        // later rungs are exactly the right response to.
        log(`tailscale is not reporting a node name: ${oneLine(status.out)}`);
      }

      const probe = host
        ? await publicCheck(host)
        : { ok: false, detail: 'tailscale not reporting a node name' };

      if (probe.ok) {
        if (lastState !== 'up') {
          log(`public link healthy (${host}, ${probe.detail})`);
        }
        if (alerted) {
          options.onAlert?.({ down: false, detail: probe.detail, strikes: 0 });
          alerted = false;
        }
        lastState = 'up';
        lastDetail = probe.detail;
        strikes = 0;
        return;
      }

      strikes += 1;
      lastState = 'down';
      lastDetail = probe.detail;
      log(`public link DOWN for ${host ?? 'unknown host'} (${probe.detail}), failure ${strikes}`);

      const step = REPAIR_LADDER[Math.min(strikes, REPAIR_LADDER.length) - 1];
      log(`  repair step ${strikes}: ${step.name}`);
      try {
        await step.run({ exec: runCmd, bin, target, port, log });
      } catch (err) {
        log(`  repair step threw: ${oneLine(String(err))}`);
      }

      if (host) {
        const after = await waitForRecovery(host);
        lastDetail = after.detail;
        if (after.ok) {
          repairs += 1;
          lastState = 'up';
          strikes = 0;
          log(`  repaired: public link healthy again (${after.detail})`);
          if (alerted) {
            options.onAlert?.({ down: false, detail: after.detail, strikes: 0 });
            alerted = false;
          }
          return;
        }
        log(`  still down after repair (${after.detail})`);
      }

      if (strikes >= ALERT_AFTER_STRIKES && !alerted) {
        alerted = true;
        options.onAlert?.({ down: true, detail: lastDetail, strikes });
      }
    } finally {
      running = false;
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
    health: () => ({
      disabled,
      state: lastState,
      detail: lastDetail,
      repairs,
      strikes,
      alerted,
      checkedAt,
      target,
      logPath,
    }),
  };
}
