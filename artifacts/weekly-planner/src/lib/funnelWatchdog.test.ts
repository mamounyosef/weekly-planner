// Tests for the public-link watchdog.
//
// What is actually at stake: on 2026-09-09 the public link died and NOTHING
// noticed for eleven days, because the old watchdog asked tailscaled whether
// the funnel was configured and believed the answer. The phone stopped syncing
// and there was no signal anywhere. So the properties asserted here are not
// niceties:
//
//   - local configuration is never accepted as evidence of health
//   - a repair that needs minutes to propagate is not mistaken for a failure
//   - the ladder escalates only after gentler steps have really failed
//   - the harsh step (restarting the service) is never reached on a blip
//   - somebody is told, exactly once per outage, and told again on recovery
//
// Run with: npx tsx src/lib/funnelWatchdog.test.ts

import assert from 'node:assert/strict';
import {
  createFunnelWatchdog,
  parseDnsName,
  resolvePublic,
  REPAIR_LADDER,
  type PublicProbe,
} from '../../funnel-watchdog';

const HOST = 'mamoun.tail27d0a5.ts.net';
const STATUS_JSON = JSON.stringify({ Self: { DNSName: `${HOST}.` } });

/**
 * The watchdog resolves through `resolvePublic`, which uses the injected
 * fetcher. Give it a fetcher that answers like dns.google so the harness above
 * can stay focused on behaviour.
 */
function dohFetcher(ips: string[], opts: { failFirst?: boolean } = {}) {
  let calls = 0;
  const f = async (url: any) => {
    calls += 1;
    if (opts.failFirst && calls === 1) throw new Error('resolver unreachable');
    return {
      ok: true,
      json: async () => ({
        Answer: ips.map(ip => ({ type: 1, data: ip })),
      }),
    } as any;
  };
  (f as any).calls = () => calls;
  return f as unknown as typeof fetch;
}

async function main() {
  console.log('--- 1. A NODE NAME IS READ OUT OF TAILSCALE STATUS, TRAILING DOT STRIPPED ---');
  {
    assert.equal(parseDnsName(STATUS_JSON), HOST);
    assert.equal(parseDnsName(JSON.stringify({ Self: { DNSName: HOST } })), HOST);
    console.log('  ok');
  }

  console.log('--- 2. A MISSING OR BROKEN STATUS YIELDS NO NAME, IT DOES NOT THROW ---');
  {
    assert.equal(parseDnsName('not json at all'), null);
    assert.equal(parseDnsName('{}'), null);
    assert.equal(parseDnsName(JSON.stringify({ Self: {} })), null);
    assert.equal(parseDnsName(JSON.stringify({ Self: { DNSName: '' } })), null);
    assert.equal(parseDnsName(''), null);
    console.log('  ok');
  }

  console.log('--- 3. RESOLUTION TAKES ONLY A RECORDS, NEVER CNAME OR SOA ---');
  {
    const fetcher = (async () => ({
      ok: true,
      json: async () => ({
        Answer: [
          { type: 5, data: 'ignore.example.' },   // CNAME
          { type: 1, data: '176.58.88.82' },      // A
          { type: 28, data: '2a00:dd80:3a::336' }, // AAAA, not connectable here
        ],
      }),
    })) as any;
    const ips = await resolvePublic(HOST, fetcher);
    assert.deepEqual(ips, ['176.58.88.82'], 'only the A record survives');
    console.log('  ok');
  }

  console.log('--- 4. AN NXDOMAIN (EMPTY ANSWER) FROM BOTH RESOLVERS MEANS NO RECORD ---');
  {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ Status: 3, Answer: [] }) };
    }) as any;
    const ips = await resolvePublic(HOST, fetcher);
    assert.deepEqual(ips, []);
    assert.equal(calls, 2, 'an empty answer is confirmed against the second resolver');
    console.log('  ok');
  }

  console.log('--- 5. ONE DEAD RESOLVER DOES NOT LOOK LIKE AN OUTAGE ---');
  {
    // The whole failure mode being guarded against is a false negative that
    // triggers a service restart. If Google is unreachable but Cloudflare
    // answers, the link is fine and must be reported fine.
    const fetcher = dohFetcher(['176.58.88.82'], { failFirst: true });
    const ips = await resolvePublic(HOST, fetcher);
    assert.deepEqual(ips, ['176.58.88.82']);
    console.log('  ok');
  }

  console.log('--- 6. A HEALTHY LINK REPAIRS NOTHING AND ALERTS NOBODY ---');
  {
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => ({ code: 0, out: args[0] === 'status' ? STATUS_JSON : '' }),
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => ({ ok: true, detail: 'HTTP 200' }),
      log: () => {},
      onAlert: () => { throw new Error('must not alert while healthy'); },
    });
    await wd.kick();
    const health = wd.health();
    assert.equal(health.state, 'up');
    assert.equal(health.strikes, 0);
    assert.equal(health.repairs, 0);
    assert.equal(health.alerted, false);
    console.log('  ok');
  }

  console.log('--- 7. A 401 IS HEALTHY: THAT IS THE PASSWORD GATE, NOT AN OUTAGE ---');
  {
    // This is the exact shape of the real deployment. Treating the gate as a
    // failure would have the watchdog restarting Tailscale every five minutes
    // forever.
    let repaired = false;
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => {
        if (args[0] !== 'status') repaired = true;
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['176.58.88.82']),
      // The real probeAddress maps any code < 500 to ok; assert the contract
      // the watchdog relies on.
      probeAddress: async () => ({ ok: true, detail: 'HTTP 401' }),
      log: () => {},
    });
    await wd.kick();
    assert.equal(wd.health().state, 'up');
    assert.equal(repaired, false, 'nothing was repaired');
    console.log('  ok');
  }

  console.log('--- 8. LOCAL CONFIG SAYING "FUNNEL ON" IS NOT EVIDENCE OF HEALTH ---');
  {
    // The 2026-09-09 regression, as a test. tailscaled reports a perfectly
    // configured funnel while the public path is dead. The watchdog must
    // believe the probe, not the config.
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => ({
        code: 0,
        out: args[0] === 'status'
          ? STATUS_JSON
          : '# Funnel on:\n https://mamoun.tail27d0a5.ts.net\n|-- / proxy http://127.0.0.1:5173',
      }),
      fetcher: dohFetcher([]),          // no public record: the real symptom
      probeAddress: async () => ({ ok: true, detail: 'unreachable' }),
      log: () => {},
    });
    await wd.kick();
    assert.equal(wd.health().state, 'down', 'the config lied and was not believed');
    assert.equal(wd.health().detail, 'no public DNS record');
    console.log('  ok');
  }

  console.log('--- 9. THE LADDER CLIMBS ONE RUNG PER CONSECUTIVE FAILURE ---');
  {
    const seen: string[][] = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (bin, args) => {
        if (args[0] !== 'status') seen[seen.length - 1].push(`${bin} ${args.join(' ')}`);
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => ({ ok: false, detail: 'connection refused' }),
      log: () => {},
    });

    for (let i = 0; i < 4; i++) {
      seen.push([]);
      await wd.kick();
    }

    assert.equal(wd.health().strikes, 4);
    // Rung 1: re-assert only.
    assert.deepEqual(seen[0], ['tailscale funnel --bg --https=443 http://127.0.0.1:5173']);
    // Rung 2: reset then re-assert.
    assert.ok(seen[1].some(c => c.includes('funnel reset')), 'rung 2 resets');
    assert.ok(seen[1].some(c => c.includes('serve reset')), 'rung 2 resets serve');
    // Rung 3: bring the backend up.
    assert.ok(seen[2].some(c => c === 'tailscale up'), 'rung 3 runs tailscale up');
    assert.ok(!seen[2].some(c => c.startsWith('net ')), 'rung 3 does NOT touch the service');
    // Rung 4: the harsh one, and only now.
    assert.ok(seen[3].some(c => c === 'net stop Tailscale'), 'rung 4 restarts the service');
    assert.ok(seen[3].some(c => c === 'net start Tailscale'));
    console.log('  ok');
  }

  console.log('--- 10. A SINGLE BLIP NEVER RESTARTS THE TAILSCALE SERVICE ---');
  {
    // The property that keeps the cure from being worse than the disease.
    const execs: string[] = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (bin, args) => {
        execs.push(`${bin} ${args.join(' ')}`);
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => ({ ok: false, detail: 'timeout' }),
      log: () => {},
    });
    await wd.kick();
    assert.ok(!execs.some(e => e.startsWith('net ')), 'one failure must not restart anything');
    console.log('  ok');
  }

  console.log('--- 11. RECOVERY RESETS THE LADDER TO THE GENTLEST RUNG ---');
  {
    let healthy = false;
    const seen: string[][] = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (bin, args) => {
        if (args[0] !== 'status') seen[seen.length - 1].push(`${bin} ${args.join(' ')}`);
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => (healthy ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'refused' }),
      log: () => {},
    });

    seen.push([]); await wd.kick();            // strike 1
    seen.push([]); await wd.kick();            // strike 2
    assert.equal(wd.health().strikes, 2);

    healthy = true;
    seen.push([]); await wd.kick();            // recovers
    assert.equal(wd.health().strikes, 0);

    healthy = false;
    seen.push([]); await wd.kick();            // a NEW outage starts at rung 1
    assert.deepEqual(seen[3], ['tailscale funnel --bg --https=443 http://127.0.0.1:5173']);
    console.log('  ok');
  }

  console.log('--- 12. A REPAIR THAT TAKES MINUTES TO PROPAGATE COUNTS AS A REPAIR ---');
  {
    // The 2026-09-20 lesson. The fix worked; the DNS record took minutes to
    // appear; probing once immediately said "still broken". That false
    // negative is what would escalate to a needless service restart.
    let t = 0;
    let repairedAt: number | null = null;
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 4 * 60 * 1000,
      now: () => t,
      sleep: async ms => { t += ms; },
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => {
        if (args[0] === 'funnel' && args[1] === '--bg') repairedAt = t;
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => {
        // Becomes healthy 2 minutes after the repair command ran.
        const ok = repairedAt !== null && t >= repairedAt + 2 * 60 * 1000;
        return ok ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'no route' };
      },
      log: () => {},
    });

    await wd.kick();
    const h = wd.health();
    assert.equal(h.state, 'up', 'the slow repair was recognised');
    assert.equal(h.repairs, 1);
    assert.equal(h.strikes, 0, 'a successful repair clears the strike');
    console.log('  ok');
  }

  console.log('--- 13. THE GRACE PERIOD IS BOUNDED, IT DOES NOT WAIT FOREVER ---');
  {
    let t = 0;
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 60 * 1000,
      now: () => t,
      sleep: async ms => { t += ms; },
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => ({ code: 0, out: args[0] === 'status' ? STATUS_JSON : '' }),
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => ({ ok: false, detail: 'never comes back' }),
      log: () => {},
    });
    await wd.kick();
    assert.ok(t <= 90 * 1000, `gave up in bounded time, waited ${t}ms`);
    assert.equal(wd.health().state, 'down');
    console.log('  ok');
  }

  console.log('--- 14. ONE ALERT PER OUTAGE, AND ONE ON RECOVERY ---');
  {
    // Eleven silent days is the bug. But an alert every five minutes would be
    // ignored within a day, which is the same bug wearing a different hat.
    let healthy = false;
    const alerts: Array<{ down: boolean }> = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => ({ code: 0, out: args[0] === 'status' ? STATUS_JSON : '' }),
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => (healthy ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'refused' }),
      log: () => {},
      onAlert: e => alerts.push({ down: e.down }),
    });

    await wd.kick();                                  // strike 1: below threshold
    assert.deepEqual(alerts, [], 'no alert on the first failure');
    await wd.kick();                                  // strike 2: alert
    assert.deepEqual(alerts, [{ down: true }]);
    await wd.kick();
    await wd.kick();                                  // still down, still quiet
    assert.deepEqual(alerts, [{ down: true }], 'no repeat alerts during one outage');

    healthy = true;
    await wd.kick();
    assert.deepEqual(alerts, [{ down: true }, { down: false }], 'recovery is announced');

    healthy = false;
    await wd.kick();
    await wd.kick();
    assert.equal(alerts.length, 3, 'a NEW outage alerts again');
    assert.equal(alerts[2].down, true);
    console.log('  ok');
  }

  console.log('--- 15. A REPAIR THAT SUCCEEDS BEFORE THE ALERT THRESHOLD STAYS QUIET ---');
  {
    let healthy = false;
    const alerts: unknown[] = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 60 * 1000,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => {
        if (args[0] === 'funnel' && args[1] === '--bg') healthy = true;
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['176.58.88.82']),
      probeAddress: async () => (healthy ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'refused' }),
      log: () => {},
      onAlert: e => alerts.push(e),
    });
    await wd.kick();
    assert.equal(wd.health().repairs, 1);
    assert.deepEqual(alerts, [], 'self-healed without bothering anyone');
    console.log('  ok');
  }

  console.log('--- 16. ONE HEALTHY INGRESS IS ENOUGH ---');
  {
    // Tailscale publishes several addresses. A client needs one. Declaring an
    // outage because the first of three is slow would be a false alarm.
    const tried: string[] = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => ({ code: 0, out: args[0] === 'status' ? STATUS_JSON : '' }),
      fetcher: dohFetcher(['1.1.1.1', '2.2.2.2', '3.3.3.3']),
      probeAddress: async (ip: string) => {
        tried.push(ip);
        return ip === '3.3.3.3' ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'refused' };
      },
      log: () => {},
    });
    await wd.kick();
    assert.equal(wd.health().state, 'up');
    assert.deepEqual(tried, ['1.1.1.1', '2.2.2.2', '3.3.3.3'], 'tried each until one answered');
    console.log('  ok');
  }

  console.log('--- 17. IT STOPS PROBING AS SOON AS ONE ADDRESS ANSWERS ---');
  {
    const tried: string[] = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => ({ code: 0, out: args[0] === 'status' ? STATUS_JSON : '' }),
      fetcher: dohFetcher(['1.1.1.1', '2.2.2.2']),
      probeAddress: async (ip: string) => { tried.push(ip); return { ok: true, detail: 'HTTP 200' }; },
      log: () => {},
    });
    await wd.kick();
    assert.deepEqual(tried, ['1.1.1.1'], 'no pointless second probe');
    console.log('  ok');
  }

  console.log('--- 18. NO TAILSCALE BINARY DISABLES THE WATCHDOG AFTER ONE LINE ---');
  {
    const logs: string[] = [];
    let ran = 0;
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      tailscaleBinary: () => null,
      runner: async () => { ran += 1; return { code: 0, out: '' }; },
      fetcher: dohFetcher([]),
      log: l => logs.push(l),
    });
    await wd.kick();
    await wd.kick();
    await wd.kick();
    assert.equal(logs.length, 1, 'said it once, not once per check');
    assert.equal(ran, 0, 'never shelled out');
    assert.equal(wd.health().disabled, true);
    console.log('  ok');
  }

  console.log('--- 19. TAILSCALE NOT REPORTING A NODE NAME IS AN OUTAGE, NOT A CRASH ---');
  {
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async () => ({ code: 1, out: 'failed to connect to local tailscaled' }),
      fetcher: dohFetcher(['1.1.1.1']),
      probeAddress: async () => ({ ok: true, detail: 'HTTP 200' }),
      log: () => {},
    });
    await wd.kick();
    const h = wd.health();
    assert.equal(h.state, 'down');
    assert.equal(h.strikes, 1, 'it counts as a failure and climbs the ladder');
    console.log('  ok');
  }

  console.log('--- 20. A THROWING REPAIR STEP DOES NOT WEDGE THE WATCHDOG ---');
  {
    let healthy = false;
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => {
        if (args[0] === 'status') return { code: 0, out: STATUS_JSON };
        throw new Error('the tailscale binary exploded');
      },
      fetcher: dohFetcher(['1.1.1.1']),
      probeAddress: async () => (healthy ? { ok: true, detail: 'HTTP 200' } : { ok: false, detail: 'refused' }),
      log: () => {},
    });
    await wd.kick();
    assert.equal(wd.health().strikes, 1, 'survived the throw');

    // And it recovers normally on the next pass once the world is well again.
    healthy = true;
    await wd.kick();
    assert.equal(wd.health().state, 'up');
    console.log('  ok');
  }

  console.log('--- 21. OVERLAPPING CHECKS ARE REFUSED ---');
  {
    // The grace period can outlast the five-minute interval. Two checks running
    // at once would double-count strikes and race on the repair ladder,
    // escalating to a service restart on what is really one failure.
    let inFlight = 0;
    let maxInFlight = 0;
    let release: (() => void) | null = null;
    const gate = new Promise<void>(r => { release = r; });

    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['1.1.1.1']),
      probeAddress: async () => ({ ok: true, detail: 'HTTP 200' }),
      log: () => {},
    });

    const a = wd.kick();
    const b = wd.kick();          // must return immediately, doing nothing
    release!();
    await Promise.all([a, b]);
    assert.equal(maxInFlight, 1, 'only one check ran at a time');
    console.log('  ok');
  }

  console.log('--- 22. THE LADDER STICKS ON ITS LAST RUNG RATHER THAN GIVING UP ---');
  {
    // A long outage may be the network, not Tailscale. Ceasing to try would
    // mean the link stays down after the network returns.
    const seen: string[][] = [];
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 0,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (bin, args) => {
        if (args[0] !== 'status') seen[seen.length - 1].push(`${bin} ${args.join(' ')}`);
        return { code: 0, out: args[0] === 'status' ? STATUS_JSON : '' };
      },
      fetcher: dohFetcher(['1.1.1.1']),
      probeAddress: async () => ({ ok: false, detail: 'refused' }),
      log: () => {},
    });

    for (let i = 0; i < 7; i++) { seen.push([]); await wd.kick(); }
    assert.equal(wd.health().strikes, 7);
    for (const i of [3, 4, 5, 6]) {
      assert.ok(seen[i].some(c => c === 'net stop Tailscale'), `pass ${i + 1} still repairing`);
    }
    console.log('  ok');
  }

  console.log('--- 23. THE LADDER IS ORDERED GENTLEST TO HARSHEST ---');
  {
    // A structural guard: if someone later reorders these, the service restart
    // could become the first response to a blip.
    assert.equal(REPAIR_LADDER.length, 4);
    const names = REPAIR_LADDER.map(s => s.name);
    assert.ok(!names[0].includes('service'), 'the first rung is not a service restart');
    assert.ok(names[REPAIR_LADDER.length - 1].includes('service'), 'the last rung is');
    console.log('  ok');
  }

  console.log('--- 24. HEALTH REPORTS ENOUGH TO DIAGNOSE WITHOUT THE LOG ---');
  {
    const wd = createFunnelWatchdog({
      rootDir: '/nowhere',
      port: 5173,
      graceMs: 0,
      now: () => 12345,
      sleep: async () => {},
      tailscaleBinary: () => 'tailscale',
      runner: async (_b, args) => ({ code: 0, out: args[0] === 'status' ? STATUS_JSON : '' }),
      fetcher: dohFetcher([]),
      probeAddress: async () => ({ ok: false, detail: 'x' }),
      log: () => {},
    });
    await wd.kick();
    const h = wd.health();
    assert.equal(h.state, 'down');
    assert.equal(h.detail, 'no public DNS record');
    assert.equal(h.strikes, 1);
    assert.equal(h.checkedAt, 12345);
    assert.equal(h.target, 'http://127.0.0.1:5173');
    console.log('  ok');
  }

  console.log('\nAll funnel watchdog tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
