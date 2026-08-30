// Tests the phone's HTTP transport against every way a mobile connection lies:
// captive portals, proxies returning HTML, expired sessions, truncated bodies,
// timeouts, and a server that answers 200 with nonsense.
//
// None of these are exotic. A phone on public Wi-Fi hits the captive-portal case
// routinely, and the difference between a clear message and "Unexpected token <"
// is the difference between a user who knows what to do and one who thinks the
// app is broken.
//
// Run with: npx tsx src/lib/syncTransport.test.ts

import assert from 'node:assert/strict';
import {
  DEFAULT_TIMEOUT_MS,
  SESSION_COOKIE,
  TransportError,
  createTransport,
  defaultSchemeFor,
  extractCookie,
  isAuthError,
  isRetryable,
  joinUrl,
  normaliseBaseUrl,
  type FetchLike,
  type FetchResponse,
} from './syncTransport';

const PH = 'android-testdevice';

/** Build a fetch stand-in from a scripted response. */
function respond(opts: {
  status?: number;
  body?: string;
  setCookie?: string | null;
  throws?: Error;
  onCall?: (url: string, init: any) => void;
}): FetchLike {
  return async (url, init) => {
    opts.onCall?.(url, init);
    if (opts.throws) throw opts.throws;
    const res: FetchResponse = {
      ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
      status: opts.status ?? 200,
      async text() { return opts.body ?? ''; },
      headers: { get: (n: string) => (n.toLowerCase() === 'set-cookie' ? opts.setCookie ?? null : null) },
    };
    return res;
  };
}

const json = (v: unknown) => JSON.stringify(v);

async function expectError(fn: () => Promise<unknown>, kind: string, msgPart?: string) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof TransportError, `Expected a TransportError, got ${err}`);
    assert.equal(err.kind, kind, `Expected kind "${kind}", got "${err.kind}": ${err.message}`);
    if (msgPart) {
      assert.ok(err.message.includes(msgPart),
        `Message "${err.message}" should mention "${msgPart}"`);
    }
    return err;
  }
  throw new Error('Expected a rejection, but the call resolved');
}

async function main() {
  console.log('--- 1. BASE URL NORMALISATION ---');
  {
    const cases: [string, string | null][] = [
      ['https://planner.example.ts.net', 'https://planner.example.ts.net'],
      ['https://planner.example.ts.net/', 'https://planner.example.ts.net'],
      ['https://planner.example.ts.net///', 'https://planner.example.ts.net'],
      ['  https://planner.example.ts.net  ', 'https://planner.example.ts.net'],
      ['planner.example.ts.net', 'https://planner.example.ts.net'],
      ['PLANNER.example.TS.net', 'https://planner.example.ts.net'],
      ['http://192.168.1.5:5173', 'http://192.168.1.5:5173'],
      ['192.168.1.5:5173', 'http://192.168.1.5:5173'],
      ['10.0.0.4:5173', 'http://10.0.0.4:5173'],
      ['172.16.3.9:5173', 'http://172.16.3.9:5173'],
      ['172.32.3.9:5173', 'https://172.32.3.9:5173'],
      ['localhost:5173', 'http://localhost:5173'],
      ['127.0.0.1:5173', 'http://127.0.0.1:5173'],
      ['planner.local', 'http://planner.local'],
      ['planner.example.ts.net:8443', 'https://planner.example.ts.net:8443'],
      ['https://host/planner', 'https://host/planner'],
      ['https://host/planner/', 'https://host/planner'],
      ['https://user:pass@host', 'https://host'],
      ['', null],
      ['   ', null],
      ['ftp://host', null],
      ['file:///etc/passwd', null],
      ['javascript:alert(1)', null],
      ['not a url at all', null],
      ['http://', null],
      ['ws://host', null],
      ['ftps://host', null],
      ['mailto:me@example.com', null],
      ['data:text/html,<h1>x</h1>', null],
      ['host:5173', 'https://host:5173'],
      ['host:notaport', null],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normaliseBaseUrl(input), expected,
        `normaliseBaseUrl(${JSON.stringify(input)})`);
    }
    assert.equal(normaliseBaseUrl(null as any), null, 'null does not throw');
    assert.equal(normaliseBaseUrl(undefined as any), null);
  }

  console.log('--- 1b. A BARE LAN ADDRESS DEFAULTS TO HTTP, A PUBLIC ONE TO HTTPS ---');
  {
    // Guessing https for the home dev server produces a TLS error that reads
    // like the PC is switched off; guessing http for the public URL would send
    // the session cookie in the clear. Neither is acceptable, so the host
    // decides — and an explicit scheme always wins over the guess.
    assert.equal(defaultSchemeFor('192.168.1.5:5173'), 'http:');
    assert.equal(defaultSchemeFor('10.1.2.3'), 'http:');
    assert.equal(defaultSchemeFor('172.16.0.1'), 'http:');
    assert.equal(defaultSchemeFor('172.31.255.255'), 'http:');
    assert.equal(defaultSchemeFor('172.15.0.1'), 'https:', 'Just outside the private range');
    assert.equal(defaultSchemeFor('172.32.0.1'), 'https:', 'and just above it');
    assert.equal(defaultSchemeFor('11.0.0.1'), 'https:', 'A public 11.x is not private');
    assert.equal(defaultSchemeFor('LOCALHOST'), 'http:', 'Case does not matter');
    assert.equal(defaultSchemeFor('planner.example.ts.net'), 'https:');
    assert.equal(defaultSchemeFor('192.168.1.5:5173/planner'), 'http:', 'A path does not confuse it');

    assert.equal(normaliseBaseUrl('http://planner.example.ts.net'), 'http://planner.example.ts.net',
      'An explicit scheme is always honoured, even when the guess would differ');
    assert.equal(normaliseBaseUrl('https://192.168.1.5:5173'), 'https://192.168.1.5:5173');
  }

  console.log('--- 2. URL JOINING NEVER DOUBLES OR DROPS A SLASH ---');
  {
    assert.equal(joinUrl('https://h', 'api/sync/pull'), 'https://h/api/sync/pull');
    assert.equal(joinUrl('https://h/', 'api/sync/pull'), 'https://h/api/sync/pull');
    assert.equal(joinUrl('https://h//', '/api/sync/pull'), 'https://h/api/sync/pull');
    assert.equal(joinUrl('https://h/planner', 'api/ping'), 'https://h/planner/api/ping');
    assert.equal(joinUrl('https://h', '///api'), 'https://h/api');
  }

  console.log('--- 3. COOKIE EXTRACTION ---');
  {
    const c = (s: string | null) => extractCookie(s, SESSION_COOKIE);
    assert.equal(c(`${SESSION_COOKIE}=abc123`), 'abc123');
    assert.equal(c(`${SESSION_COOKIE}=abc123; Path=/; HttpOnly`), 'abc123');
    assert.equal(c(`${SESSION_COOKIE}=abc123; Expires=Wed, 09 Jun 2027 10:18:14 GMT; Path=/`),
      'abc123', 'A comma inside Expires must not split the cookie');
    assert.equal(c(`other=x; Path=/, ${SESSION_COOKIE}=abc123; Path=/`), 'abc123',
      'Finds the right cookie among several');
    assert.equal(c(`${SESSION_COOKIE}=a.b-c_d%20e`), 'a.b-c_d%20e', 'Token characters survive');

    assert.equal(c(null), null);
    assert.equal(c(undefined as any), null);
    assert.equal(c(''), null);
    assert.equal(c('unrelated=1'), null);
    assert.equal(c(`${SESSION_COOKIE}=`), null, 'An empty value is not a session');
    assert.equal(c(`${SESSION_COOKIE}=; Path=/`), null, 'and neither is a deletion cookie');
    assert.equal(extractCookie(`not_${SESSION_COOKIE}=x`, SESSION_COOKIE), null,
      'A cookie whose name merely ends with ours is not ours');
  }

  console.log('--- 4. A BAD BASE URL FAILS AT CONSTRUCTION, NOT MID-SYNC ---');
  {
    // Note "nonsense" is NOT here: a single word is a legal hostname, and
    // refusing it would block anyone whose planner is on a machine name.
    for (const bad of ['', '   ', 'ftp://x', 'ws://x', 'not a url at all', 'http://']) {
      assert.throws(
        () => createTransport({ baseUrl: bad, fetchImpl: respond({}) }),
        /not a usable server address/,
        `"${bad}" is refused up front`,
      );
    }
  }

  console.log('--- 5. LOGIN CAPTURES THE SESSION ---');
  {
    let stored: string | null | undefined;
    let seenUrl = '';
    let seenBody: any;
    const t = createTransport({
      baseUrl: 'https://planner.test',
      onSession: s => { stored = s; },
      fetchImpl: respond({
        setCookie: `${SESSION_COOKIE}=tok-123; Path=/; HttpOnly`,
        body: json({ success: true, user: { username: 'mamoun', name: "Ma'moun" } }),
        onCall: (url, init) => { seenUrl = url; seenBody = JSON.parse(init.body); },
      }),
    });

    const who = await t.login('mamoun', 'secret');
    assert.equal(seenUrl, 'https://planner.test/api/auth/login');
    assert.deepEqual(seenBody, { username: 'mamoun', password: 'secret' });
    assert.equal(who.username, 'mamoun');
    assert.equal(who.name, "Ma'moun");
    assert.equal(stored, 'tok-123', 'The session was handed to the caller to store');
    assert.equal(t.session, 'tok-123');
  }

  console.log('--- 6. LOGIN FAILURES ARE SPECIFIC ---');
  {
    const mk = (o: any) => createTransport({ baseUrl: 'https://planner.test', fetchImpl: respond(o) });

    await expectError(
      () => mk({ status: 401, body: json({ error: 'Invalid username or password' }) }).login('a', 'b'),
      'auth', 'not right');

    await expectError(() => mk({ status: 500, body: 'boom' }).login('a', 'b'), 'server');
    await expectError(() => mk({ status: 404, body: '' }).login('a', 'b'), 'protocol');
    await expectError(
      () => mk({ throws: new Error('Network request failed') }).login('a', 'b'),
      'network', 'Could not reach');
    await expectError(
      () => mk({ throws: new Error('The operation was aborted') }).login('a', 'b'),
      'timeout', 'did not answer in time');

    // A 200 with no cookie means the server is not the planner.
    await expectError(
      () => mk({ status: 200, body: json({ success: true }) }).login('a', 'b'),
      'protocol', 'did not issue a session');

    // A 200 with a cookie but unparseable body still logs in — the cookie is
    // what actually matters, and failing here would be needlessly brittle.
    const odd = createTransport({
      baseUrl: 'https://planner.test',
      fetchImpl: respond({ setCookie: `${SESSION_COOKIE}=tok`, body: 'not json' }),
    });
    const who = await odd.login('mamoun', 'x');
    assert.equal(who.username, 'mamoun', 'Falls back to the username we sent');
  }

  console.log('--- 6b. LOGIN CREDENTIALS ARE NEVER PUT IN THE URL ---');
  {
    let seenUrl = '';
    const t = createTransport({
      baseUrl: 'https://planner.test',
      fetchImpl: respond({
        setCookie: `${SESSION_COOKIE}=tok`,
        body: json({ success: true }),
        onCall: url => { seenUrl = url; },
      }),
    });
    await t.login('mamoun', 'hunter2');
    assert.ok(!seenUrl.includes('hunter2'), 'The password is not in the URL');
    assert.ok(!seenUrl.includes('mamoun'), 'and neither is the username');
  }

  console.log('--- 7. THE SESSION IS ATTACHED TO EVERY REQUEST ---');
  {
    const seen: Record<string, string>[] = [];
    const t = createTransport({
      baseUrl: 'https://planner.test',
      session: 'tok-abc',
      fetchImpl: respond({
        body: json({ ops: [], cursor: 1, conflicts: [], needsFullResync: false, serverTime: 5 }),
        onCall: (_u, init) => seen.push(init.headers),
      }),
    });

    await t.pull(PH, 0);
    await t.ack(PH, 1);
    assert.equal(seen.length, 2);
    for (const headers of seen) {
      assert.equal(headers.Cookie, `${SESSION_COOKIE}=tok-abc`, 'Cookie header is explicit');
      assert.equal(headers.Accept, 'application/json');
      assert.equal(headers['Content-Type'], 'application/json');
    }
  }

  console.log('--- 8. AN EXPIRED SESSION IS REPORTED, NOT RETRIED FOREVER ---');
  {
    let cleared = false;
    const t = createTransport({
      baseUrl: 'https://planner.test',
      session: 'stale',
      onSession: s => { if (s === null) cleared = true; },
      fetchImpl: respond({ status: 401, body: json({ error: 'Authentication required' }) }),
    });

    const err = await expectError(() => t.pull(PH, 0), 'auth', 'sign in again');
    assert.equal(cleared, true, 'The dead session is cleared from storage');
    assert.equal(t.session, null);
    assert.ok(isAuthError(err), 'and is flagged as an auth problem');
    assert.ok(!isRetryable(err), 'so the sync loop stops retrying and asks for a login');

    // 403 behaves the same way.
    const t2 = createTransport({
      baseUrl: 'https://planner.test', session: 's',
      fetchImpl: respond({ status: 403, body: '' }),
    });
    await expectError(() => t2.push(PH, []), 'auth');
  }

  console.log('--- 9. A CAPTIVE PORTAL OR PROXY PAGE GIVES A USEFUL MESSAGE ---');
  {
    const htmlPages = [
      '<!DOCTYPE html><html><body>Sign in to Wi-Fi</body></html>',
      '<html><head><title>502 Bad Gateway</title></head></html>',
      '﻿{"looks":"like json but has a BOM"}',
      'ops=[]&cursor=1',
    ];
    for (const body of htmlPages) {
      const t = createTransport({
        baseUrl: 'https://planner.test', session: 's',
        fetchImpl: respond({ status: 200, body }),
      });
      const err = await expectError(() => t.pull(PH, 0), 'protocol', 'not planner data');
      assert.ok(!err.message.includes('JSON'), 'The message avoids parser jargon');
      assert.ok(err.message.includes('Wi-Fi'), 'and points at the likely cause');
    }
  }

  console.log('--- 10. SERVER ERRORS SURFACE THEIR MESSAGE WHEN THERE IS ONE ---');
  {
    const withJson = createTransport({
      baseUrl: 'https://planner.test', session: 's',
      fetchImpl: respond({ status: 400, body: json({ error: 'too many ops in one push (max 5000)' }) }),
    });
    await expectError(() => withJson.push(PH, []), 'protocol', 'too many ops');

    const withHtml = createTransport({
      baseUrl: 'https://planner.test', session: 's',
      fetchImpl: respond({ status: 502, body: '<html>Bad Gateway</html>' }),
    });
    const err = await expectError(() => withHtml.push(PH, []), 'server', '502');
    assert.ok(isRetryable(err), 'A 5xx is worth retrying');

    const empty = createTransport({
      baseUrl: 'https://planner.test', session: 's',
      fetchImpl: respond({ status: 503, body: '' }),
    });
    await expectError(() => empty.pull(PH, 0), 'server', '503');
  }

  console.log('--- 11. NETWORK FAILURES AND TIMEOUTS ---');
  {
    const messages = [
      'Network request failed',
      'TypeError: Failed to fetch',
      'ECONNREFUSED',
      'getaddrinfo ENOTFOUND planner.test',
    ];
    for (const m of messages) {
      const t = createTransport({
        baseUrl: 'https://planner.test', session: 's',
        fetchImpl: respond({ throws: new Error(m) }),
      });
      const err = await expectError(() => t.pull(PH, 0), 'network', 'Could not reach');
      assert.ok(isRetryable(err), `"${m}" is retryable`);
    }

    for (const m of ['The operation was aborted', 'AbortError: signal is aborted']) {
      const t = createTransport({
        baseUrl: 'https://planner.test', session: 's',
        fetchImpl: respond({ throws: new Error(m) }),
      });
      const err = await expectError(() => t.pull(PH, 0), 'timeout');
      assert.ok(isRetryable(err), 'A timeout is retryable');
    }

    // A non-Error thrown value must not crash the classifier.
    const weird = createTransport({
      baseUrl: 'https://planner.test', session: 's',
      fetchImpl: (async () => { throw 'a bare string'; }) as any,
    });
    await expectError(() => weird.pull(PH, 0), 'network');
  }

  console.log('--- 12. A REQUEST THAT HANGS IS ABORTED ---');
  {
    let signal: AbortSignal | undefined;
    const t = createTransport({
      baseUrl: 'https://planner.test',
      session: 's',
      timeoutMs: 30,
      fetchImpl: (_u, init) => new Promise((_res, rej) => {
        signal = init?.signal;
        init?.signal?.addEventListener('abort', () => rej(new Error('The operation was aborted')));
      }),
    });

    await expectError(() => t.pull(PH, 0), 'timeout', 'did not answer in time');
    assert.ok(signal?.aborted, 'The request was actually aborted, not merely abandoned');
    assert.equal(DEFAULT_TIMEOUT_MS, 20_000, 'and the default timeout is a sane 20 seconds');
  }

  console.log('--- 13. MALFORMED SUCCESS BODIES ARE COERCED, NOT TRUSTED ---');
  {
    // The server should never do this, but a bad OTA or a proxy rewriting bodies
    // could. Every field is coerced so the sync loop cannot be handed a string
    // where it expects an array and crash inside the merge.
    const cases: [string, unknown][] = [
      ['{}', {}],
      [json({ ops: 'not an array', cursor: 'abc', conflicts: null, needsFullResync: 'yes' }), {}],
      [json({ ops: null, cursor: -1 }), {}],
      [json(null), {}],
      [json([]), {}],
    ];
    for (const [body] of cases) {
      const t = createTransport({
        baseUrl: 'https://planner.test', session: 's',
        fetchImpl: respond({ body }),
      });
      const pull = await t.pull(PH, 0);
      assert.ok(Array.isArray(pull.ops), `ops is an array for body ${body}`);
      assert.equal(typeof pull.cursor, 'number');
      assert.ok(Number.isFinite(pull.cursor), 'and a finite one');
      assert.ok(Array.isArray(pull.conflicts));
      assert.equal(typeof pull.needsFullResync, 'boolean',
        'needsFullResync is a real boolean — "yes" must not become true by accident');

      const push = await t.push(PH, []);
      assert.equal(typeof push.accepted, 'number');
      assert.ok(Array.isArray(push.conflicts));

      const snap = await t.snapshot(PH);
      assert.equal(typeof snap.stores, 'object');
      assert.ok(snap.stores !== null);
    }

    // "needsFullResync": "yes" must NOT trigger a resync.
    const sneaky = createTransport({
      baseUrl: 'https://planner.test', session: 's',
      fetchImpl: respond({ body: json({ needsFullResync: 'yes', ops: [] }) }),
    });
    assert.equal((await sneaky.pull(PH, 0)).needsFullResync, false,
      'Only a literal true triggers the destructive path');
  }

  console.log('--- 14. AN EMPTY 200 BODY IS NOT AN ERROR ---');
  {
    const t = createTransport({
      baseUrl: 'https://planner.test', session: 's',
      fetchImpl: respond({ status: 200, body: '' }),
    });
    const pull = await t.pull(PH, 0);
    assert.deepEqual(pull.ops, [], 'An empty body reads as an empty answer');
    assert.equal(pull.cursor, 0);
    assert.equal(pull.needsFullResync, false, 'and never as "resync everything"');
  }

  console.log('--- 15. A ROTATED COOKIE IS PICKED UP MID-SESSION ---');
  {
    const stored: (string | null)[] = [];
    let call = 0;
    const t = createTransport({
      baseUrl: 'https://planner.test',
      session: 'old',
      onSession: s => stored.push(s),
      fetchImpl: async (_u, _i) => {
        call += 1;
        return {
          ok: true, status: 200,
          async text() { return json({ ops: [], cursor: call }); },
          headers: {
            get: (n: string) => (n.toLowerCase() === 'set-cookie' && call === 2
              ? `${SESSION_COOKIE}=rotated; Path=/`
              : null),
          },
        };
      },
    });

    await t.pull(PH, 0);
    assert.equal(t.session, 'old');
    await t.pull(PH, 0);
    assert.equal(t.session, 'rotated', 'A refreshed cookie replaces the old one');
    assert.deepEqual(stored, ['rotated'], 'and is stored exactly once');
    await t.pull(PH, 0);
    assert.deepEqual(stored, ['rotated'], 'An unchanged cookie is not re-stored');
  }

  console.log('--- 16. PING IS A BOOLEAN, NEVER A THROW ---');
  {
    const up = createTransport({
      baseUrl: 'https://planner.test', session: 's', fetchImpl: respond({ body: json({ ok: true }) }),
    });
    assert.equal(await up.ping(), true);

    for (const opts of [
      { throws: new Error('Network request failed') },
      { status: 500, body: '' },
      { status: 401, body: '' },
      { status: 200, body: '<html>portal</html>' },
    ]) {
      const down = createTransport({
        baseUrl: 'https://planner.test', session: 's', fetchImpl: respond(opts),
      });
      assert.equal(await down.ping(), false, `ping returns false for ${JSON.stringify(opts)}`);
    }
  }

  console.log('--- 17. REQUESTS GO TO THE RIGHT PATHS WITH THE RIGHT SHAPES ---');
  {
    const calls: { url: string; body: any }[] = [];
    const t = createTransport({
      baseUrl: 'https://planner.test/planner',
      session: 's',
      fetchImpl: respond({
        body: json({ ops: [], cursor: 0, conflicts: [], stores: {} }),
        onCall: (url, init) => calls.push({ url, body: init.body ? JSON.parse(init.body) : null }),
      }),
    });

    await t.pull(PH, 7);
    await t.push(PH, []);
    await t.ack(PH, 9);
    await t.snapshot(PH);
    await t.resolve(PH, 'c1', 'loser');

    assert.deepEqual(calls.map(c => c.url), [
      'https://planner.test/planner/api/sync/pull',
      'https://planner.test/planner/api/sync/push',
      'https://planner.test/planner/api/sync/ack',
      'https://planner.test/planner/api/sync/snapshot',
      'https://planner.test/planner/api/sync/resolve',
    ], 'A path-prefixed server address is honoured on every route');

    assert.deepEqual(calls[0].body, { deviceId: PH, since: 7 });
    assert.deepEqual(calls[1].body, { deviceId: PH, ops: [], platform: 'android' });
    assert.deepEqual(calls[2].body, { deviceId: PH, cursor: 9 });
    assert.deepEqual(calls[3].body, { deviceId: PH });
    assert.deepEqual(calls[4].body, { deviceId: PH, conflictId: 'c1', choice: 'loser' });
  }

  console.log('--- 18. NO SESSION MEANS NO COOKIE HEADER AT ALL ---');
  {
    let headers: any;
    const t = createTransport({
      baseUrl: 'https://planner.test',
      fetchImpl: respond({ body: json({ ops: [] }), onCall: (_u, i) => { headers = i.headers; } }),
    });
    await t.pull(PH, 0);
    assert.equal(headers.Cookie, undefined,
      'Sending "Cookie: planner_session=null" would be worse than sending nothing');
  }

  console.log('\nALL PASS (HTTP transport: URLs, cookies, portals, timeouts, coercion)');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
