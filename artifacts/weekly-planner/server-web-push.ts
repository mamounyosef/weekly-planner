/**
 * Web Push, implemented directly on Node's crypto.
 *
 * This is deliberately not the `web-push` npm package: this workspace's pnpm
 * store refuses an incremental add (its virtual-store-dir length differs), and
 * recreating node_modules to gain one dependency is a far bigger risk to a
 * working app than 200 lines of well-specified crypto. Everything here is
 * standard and testable:
 *
 *   • VAPID (RFC 8292) — an ES256 JWT identifying this server to the push
 *     service, so Chrome/Mozilla accept the send.
 *   • aes128gcm (RFC 8188) with the key derivation from RFC 8291 — the payload
 *     is encrypted to the subscriber's public key, so the push service itself
 *     never sees the notification text.
 *
 * The push service is Google's FCM for Chrome. That is what makes the phone
 * reliable: the message is delivered by the OS-level channel Chrome already
 * keeps alive, so the planner does not need to have been opened, and a phone
 * that is off or out of signal receives it on reconnect (within the TTL).
 */
import crypto from 'crypto';
import fsp from 'fs/promises';
import path from 'path';

const b64url = (buf: Buffer): string => buf.toString('base64url');
const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

export interface VapidKeys {
  publicKey: string;   // base64url, uncompressed P-256 point (65 bytes)
  privateKey: string;  // base64url, raw scalar (32 bytes)
  subject: string;     // mailto: or https: identifying the sender
}

export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  /** Free-text label so the settings screen can say "Pixel, Chrome". */
  label?: string;
  deviceId?: string;
  userAgent?: string;
  /**
   * Subscribed from this very machine (a loopback request). Used to keep the PC
   * from being notified twice: once natively by a Windows toast and again by
   * push to its own browsers.
   */
  local?: boolean;
  createdAt: number;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  failures?: number;
}

// ─── Key material ────────────────────────────────────────────────────────────

/** Split an EC public key into its raw uncompressed 65-byte point. */
function rawPublicFromKeyObject(key: crypto.KeyObject): Buffer {
  const jwk = key.export({ format: 'jwk' }) as { x: string; y: string };
  return Buffer.concat([Buffer.from([0x04]), fromB64url(jwk.x), fromB64url(jwk.y)]);
}

export function generateVapidKeys(subject: string): VapidKeys {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return {
    publicKey: b64url(rawPublicFromKeyObject(publicKey)),
    privateKey: jwk.d,
    subject,
  };
}

/** Rebuild a signing key from the stored raw scalar plus the public point. */
function vapidPrivateKeyObject(keys: VapidKeys): crypto.KeyObject {
  const pub = fromB64url(keys.publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) throw new Error('VAPID public key is not an uncompressed P-256 point');
  // Rebuilt as a JWK: only the private scalar is stored on disk, and the public
  // half is derived from the point the subscriptions were signed against, so the
  // two can never drift apart.
  return crypto.createPrivateKey({
    format: 'jwk',
    key: {
      kty: 'EC',
      crv: 'P-256',
      d: keys.privateKey,
      x: b64url(pub.subarray(1, 33)),
      y: b64url(pub.subarray(33, 65)),
    },
  } as unknown as crypto.PrivateKeyInput);
}

/**
 * Load the server's VAPID identity, creating it on first use. The keys must be
 * stable forever: every existing subscription is bound to this exact public
 * key, and regenerating it silently invalidates every device already signed up.
 */
export async function loadOrCreateVapid(filePath: string, subject: string): Promise<VapidKeys> {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf-8'));
    if (parsed?.publicKey && parsed?.privateKey) {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject: parsed.subject || subject };
    }
  } catch { /* first run */ }

  const keys = generateVapidKeys(subject);
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(keys, null, 2), 'utf-8');
  return keys;
}

// ─── VAPID JWT ───────────────────────────────────────────────────────────────

export function signVapidJwt(keys: VapidKeys, audience: string, expiresInSec = 12 * 3600): string {
  const header = b64url(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64url(Buffer.from(JSON.stringify({
    aud: audience,
    exp: Math.floor(Date.now() / 1000) + expiresInSec,
    sub: keys.subject,
  })));
  const signingInput = `${header}.${body}`;
  // ES256 wants the raw r||s pair. Node emits DER unless told otherwise, and a
  // DER signature is rejected by every push service with an opaque 401.
  const signature = crypto.sign('sha256', Buffer.from(signingInput), {
    key: vapidPrivateKeyObject(keys),
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

// ─── Payload encryption (RFC 8291 / RFC 8188) ────────────────────────────────

const hmac = (key: Buffer, data: Buffer): Buffer => crypto.createHmac('sha256', key).update(data).digest();

/** One-block HKDF, which is all this scheme ever needs. */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

export function encryptPayload(
  payload: string,
  uaPublicB64: string,
  authSecretB64: string,
): Buffer {
  const uaPublic = fromB64url(uaPublicB64);
  const authSecret = fromB64url(authSecretB64);
  if (uaPublic.length !== 65) throw new Error('subscription p256dh is not a P-256 point');

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const sharedSecret = ecdh.computeSecret(uaPublic);

  // The "WebPush: info" step binds the derived key to BOTH parties' public
  // keys, which is what stops a push service from swapping one in.
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    uaPublic,
    asPublic,
  ]);
  const ikm = hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.randomBytes(16);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);

  // 0x02 is the last-record delimiter. There is only ever one record here.
  const plaintext = Buffer.concat([Buffer.from(payload, 'utf-8'), Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const recordSize = Buffer.alloc(4);
  recordSize.writeUInt32BE(4096, 0);
  const header = Buffer.concat([salt, recordSize, Buffer.from([asPublic.length]), asPublic]);

  return Buffer.concat([header, ciphertext]);
}

// ─── Sending ─────────────────────────────────────────────────────────────────

export interface SendResult {
  ok: boolean;
  status: number;
  /** The subscription is dead and should be removed from the store. */
  gone: boolean;
  error?: string;
}

export interface SendOptions {
  /**
   * Seconds the push service holds the message for a phone that is off or out
   * of signal. Deliberately long: an unread reminder is still worth delivering
   * when the phone comes back, which is the whole point of the exercise.
   */
  ttlSeconds?: number;
  /** 'high' asks the service not to batch it behind a doze window. */
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Collapse key: a newer message with the same topic replaces the queued one. */
  topic?: string;
}

export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: string,
  vapid: VapidKeys,
  opts: SendOptions = {},
): Promise<SendResult> {
  let audience: string;
  try {
    const u = new URL(sub.endpoint);
    audience = `${u.protocol}//${u.host}`;
  } catch {
    return { ok: false, status: 0, gone: true, error: 'malformed endpoint' };
  }

  let body: Buffer;
  try {
    body = encryptPayload(payload, sub.keys.p256dh, sub.keys.auth);
  } catch (err) {
    return { ok: false, status: 0, gone: true, error: `encrypt failed: ${(err as Error).message}` };
  }

  const headers: Record<string, string> = {
    Authorization: `vapid t=${signVapidJwt(vapid, audience)}, k=${vapid.publicKey}`,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(body.length),
    TTL: String(opts.ttlSeconds ?? 24 * 3600),
    Urgency: opts.urgency ?? 'high',
  };
  // A topic must be a short base64url token; anything else is a 400 from FCM.
  if (opts.topic) headers.Topic = opts.topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'planner';

  try {
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers,
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(15000),
    });

    if (res.ok || res.status === 201) return { ok: true, status: res.status, gone: false };

    // 404/410 is the push service saying this subscription no longer exists.
    // Anything else (429, 5xx) is transient and the subscription is kept.
    const gone = res.status === 404 || res.status === 410;
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, gone, error: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, gone: false, error: (err as Error).message };
  }
}
