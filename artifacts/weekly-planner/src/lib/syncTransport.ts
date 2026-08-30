// ─── HTTP transport (the phone's side of the wire) ───────────────────────────
// Turns the SyncTransport contract into requests against the planner server.
// `fetch` is injected so every failure below is reproducible in a test: a
// timeout, a captive-portal login page, a proxy returning HTML, an expired
// session, a truncated body.
//
// WHY COOKIES ARE HANDLED BY HAND
// React Native's fetch does not persist cookies dependably across app restarts
// or across the Android/OkHttp stack. Relying on it would mean the phone
// silently logging itself out mid-sync. So the session cookie is read from the
// login response, stored by the caller (in SecureStore), and attached to every
// request as an explicit header. Nothing depends on an implicit cookie jar.

import type {
  PullResponse,
  PushResponse,
  ResolveChoice,
  SnapshotResponse,
  SyncTransport,
} from './syncClient';
import type { SyncOp } from './sync';

export const SESSION_COOKIE = 'planner_session';

/** Thrown for anything the caller may want to treat differently. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly kind: 'network' | 'auth' | 'server' | 'protocol' | 'timeout',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

export const isAuthError = (err: unknown): boolean =>
  err instanceof TransportError && err.kind === 'auth';

/** Retrying makes sense for these; an auth or protocol error will just repeat. */
export const isRetryable = (err: unknown): boolean =>
  err instanceof TransportError && (err.kind === 'network' || err.kind === 'timeout' || err.kind === 'server');

// ─── URL handling ────────────────────────────────────────────────────────────

/**
 * Which scheme to assume when the user typed a bare address.
 *
 * A public hostname gets https — anything else would downgrade a Funnel URL to
 * cleartext. But the dev server on the home network speaks plain http, and
 * defaulting "192.168.1.5:5173" to https would fail with a TLS error that reads
 * like the server is down. So loopback and private ranges get http.
 */
export function defaultSchemeFor(hostish: string): 'http:' | 'https:' {
  const host = hostish.split('/')[0].split(':')[0].toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) return 'http:';
  if (host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return 'http:';
  // RFC 1918 private ranges.
  if (/^10\./.test(host)) return 'http:';
  if (/^192\.168\./.test(host)) return 'http:';
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return 'http:';
  return 'https:';
}

/**
 * Normalise whatever the user typed into a base URL.
 *
 * People paste "planner.tail1234.ts.net", "https://…/", "…//" and trailing
 * spaces. Getting this wrong produces a double slash or a missing scheme, and
 * the app then looks broken for a reason no one can see.
 */
export function normaliseBaseUrl(raw: string): string | null {
  const trimmed = String(raw ?? '').trim();
  if (trimmed.length === 0) return null;

  // Anything carrying a scheme that is not http(s) is refused outright. Without
  // this, "ftp://host" would have "https://" glued in front of it and quietly
  // become the nonsense address https://ftp//host.
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme && !/^https?$/i.test(scheme[1])) {
    // A bare "host:5173" also matches the pattern above; allow it when what
    // follows the colon is a port number rather than a scheme separator.
    if (!/^[a-z][a-z0-9+.-]*:\d+(\/|$)/i.test(trimmed)) return null;
  }

  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed
    : `${defaultSchemeFor(trimmed)}//${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (!url.hostname) return null;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  // Keep any path prefix (a reverse proxy may mount the planner under one) but
  // never a trailing slash, so joining is always `${base}/api/...`.
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export function joinUrl(base: string, path: string): string {
  const left = base.replace(/\/+$/, '');
  const right = path.replace(/^\/+/, '');
  return `${left}/${right}`;
}

/** Pull one cookie's value out of a Set-Cookie header, ignoring its attributes. */
export function extractCookie(setCookie: string | null | undefined, name: string): string | null {
  if (!setCookie) return null;
  // Several cookies may arrive comma-joined; attributes contain commas too
  // (Expires=Wed, 09 Jun 2027), so split on the cookie-name boundary instead.
  const pattern = new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]*)`);
  const match = pattern.exec(setCookie);
  if (!match) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

// ─── The client ──────────────────────────────────────────────────────────────

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<FetchResponse>;

export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}

export interface TransportOptions {
  baseUrl: string;
  fetchImpl: FetchLike;
  /** Session cookie value, if we already have one. */
  session?: string | null;
  /** Called whenever a fresh session is issued, so it can be stored. */
  onSession?: (session: string | null) => void;
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

export function createTransport(opts: TransportOptions) {
  const normalised = normaliseBaseUrl(opts.baseUrl);
  if (!normalised) {
    throw new TransportError(`"${opts.baseUrl}" is not a usable server address.`, 'protocol');
  }
  const base: string = normalised;

  let session = opts.session ?? null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function request<T>(
    path: string,
    method: string,
    body?: unknown,
    /** Overrides the default, for a request the server is expected to hold. */
    overrideTimeoutMs?: number,
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (session) headers.Cookie = `${SESSION_COOKIE}=${session}`;

    // A phone on a dying connection can hold a socket open indefinitely. Without
    // this the sync loop would appear to hang rather than retry.
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), overrideTimeoutMs ?? timeoutMs)
      : null;

    let res: FetchResponse;
    try {
      res = await opts.fetchImpl(joinUrl(base, path), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller?.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const aborted = /abort/i.test(message);
      throw new TransportError(
        aborted ? 'The server did not answer in time.' : 'Could not reach the planner.',
        aborted ? 'timeout' : 'network',
      );
    } finally {
      if (timer) clearTimeout(timer);
    }

    const fresh = extractCookie(res.headers.get('set-cookie'), SESSION_COOKIE);
    if (fresh && fresh !== session) {
      session = fresh;
      opts.onSession?.(fresh);
    }

    if (res.status === 401 || res.status === 403) {
      session = null;
      opts.onSession?.(null);
      throw new TransportError('Signed out — please sign in again.', 'auth', res.status);
    }

    const raw = await res.text().catch(() => '');

    if (!res.ok) {
      // A JSON error body is the useful case; anything else (an HTML error page
      // from a proxy, an empty body) becomes a plain status message rather than
      // a parse crash the user cannot act on.
      let detail = '';
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed.error === 'string') detail = parsed.error;
      } catch { /* not JSON */ }
      throw new TransportError(
        detail || `The server returned ${res.status}.`,
        res.status >= 500 ? 'server' : 'protocol',
        res.status,
      );
    }

    if (raw.trim().length === 0) return undefined as T;

    try {
      return JSON.parse(raw) as T;
    } catch {
      // Almost always a captive portal or a login page served in place of the
      // API. Saying so is far more useful than "Unexpected token < in JSON".
      throw new TransportError(
        'The server sent something that is not planner data — check the address, or your Wi-Fi sign-in page.',
        'protocol',
        res.status,
      );
    }
  }

  return {
    get session() {
      return session;
    },

    /** Sign in and capture the session cookie. */
    async login(username: string, password: string): Promise<{ username: string; name: string }> {
      const res = await opts.fetchImpl(joinUrl(base, 'api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ username, password }),
      }).catch(err => {
        const message = err instanceof Error ? err.message : String(err);
        throw new TransportError(
          /abort/i.test(message) ? 'The server did not answer in time.' : 'Could not reach the planner.',
          /abort/i.test(message) ? 'timeout' : 'network',
        );
      });

      const raw = await res.text().catch(() => '');
      if (res.status === 401) {
        throw new TransportError('That username or password is not right.', 'auth', 401);
      }
      if (!res.ok) {
        throw new TransportError(`The server returned ${res.status}.`,
          res.status >= 500 ? 'server' : 'protocol', res.status);
      }

      const cookie = extractCookie(res.headers.get('set-cookie'), SESSION_COOKIE);
      if (!cookie) {
        throw new TransportError('The server did not issue a session.', 'protocol', res.status);
      }
      session = cookie;
      opts.onSession?.(cookie);

      let parsed: any = {};
      try { parsed = JSON.parse(raw); } catch { /* the cookie is what matters */ }
      const username_ = parsed?.user?.username ?? username;
      return { username: username_, name: parsed?.user?.name ?? username_ };
    },

    /** Cheap liveness check, used to decide online vs offline. */
    async ping(): Promise<boolean> {
      try {
        await request('api/ping', 'GET');
        return true;
      } catch {
        return false;
      }
    },

    // ── The SyncTransport contract ──
    /**
     * @param waitMs how long the server may hold this open with nothing to say.
     *
     * The timeout must outlast the hold, or the app aborts its own request and
     * reads a perfectly healthy server as offline. The margin covers a slow
     * round trip over the tunnel on top of the agreed wait.
     */
    async pull(deviceId: string, since: number, waitMs = 0): Promise<PullResponse> {
      const res = await request<Partial<PullResponse>>(
        'api/sync/pull', 'POST',
        // `wait` only when it means something, so an ordinary pull stays the
        // exact request it has always been.
        waitMs > 0 ? { deviceId, since, wait: waitMs } : { deviceId, since },
        waitMs > 0 ? waitMs + timeoutMs : undefined,
      );
      return {
        ops: Array.isArray(res?.ops) ? res.ops : [],
        cursor: Number(res?.cursor) || 0,
        conflicts: Array.isArray(res?.conflicts) ? res.conflicts : [],
        needsFullResync: res?.needsFullResync === true,
        serverTime: Number(res?.serverTime) || 0,
        // THE CLOCK. Dropping this field was the bug behind "I tick it on my
        // phone and it un-ticks itself". Rebuilding the response field by field
        // is right -- the body is untrusted -- but the omission made
        // `adoptClock` a permanent no-op, so the phone's lamport never caught up
        // with the PC's. Every tap it made was then stamped BELOW changes the PC
        // had already written, and lost the merge despite happening later. Kept
        // optional: a value that is missing or nonsense must leave the clock
        // alone rather than reset it to zero.
        lamport: Number.isFinite(Number(res?.lamport)) ? Number(res?.lamport) : undefined,
      };
    },

    async push(deviceId: string, ops: SyncOp[]): Promise<PushResponse> {
      const res = await request<Partial<PushResponse>>('api/sync/push', 'POST', {
        deviceId, ops, platform: 'android',
      });
      return {
        accepted: Number(res?.accepted) || 0,
        ignored: Number(res?.ignored) || 0,
        rejected: Number(res?.rejected) || 0,
        conflicts: Array.isArray(res?.conflicts) ? res.conflicts : [],
        cursor: Number(res?.cursor) || 0,
        // Adopted straight after sending, so the NEXT tap is stamped against a
        // current clock instead of waiting for the following poll.
        lamport: Number.isFinite(Number(res?.lamport)) ? Number(res?.lamport) : undefined,
      };
    },

    async ack(deviceId: string, cursor: number): Promise<{ cursor: number }> {
      const res = await request<{ cursor?: number }>('api/sync/ack', 'POST', { deviceId, cursor });
      return { cursor: Number(res?.cursor) || cursor };
    },

    async snapshot(deviceId: string): Promise<SnapshotResponse> {
      const res = await request<Partial<SnapshotResponse>>('api/sync/snapshot', 'POST', { deviceId });
      return {
        stores: (res?.stores && typeof res.stores === 'object') ? res.stores : {},
        cursor: Number(res?.cursor) || 0,
        lamport: Number(res?.lamport) || 0,
        conflicts: Array.isArray(res?.conflicts) ? res.conflicts : [],
        serverTime: Number(res?.serverTime) || 0,
      };
    },

    async resolve(deviceId: string, conflictId: string, choice: ResolveChoice): Promise<unknown> {
      return request('api/sync/resolve', 'POST', { deviceId, conflictId, choice });
    },
  } satisfies SyncTransport & Record<string, unknown>;
}

export type PlannerTransport = ReturnType<typeof createTransport>;
