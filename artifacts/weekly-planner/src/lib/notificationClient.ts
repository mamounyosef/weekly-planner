import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getDeviceId, getDeviceKind } from './deviceSettings';
import {
  activeNotifications,
  coerceStore,
  groupNotifications,
  notificationTag,
  type NotificationRecord,
  type NotificationStore,
} from './notifications';

// ─── The browser side of notifications ───────────────────────────────────────
//
// The server is the source of truth: it schedules, it delivers, and it owns
// read state. This file does four things around that:
//
//   1. Keeps a live copy of the store, fed by the existing db-stream SSE (the
//      pages hand it their `notifications` events, so no second connection is
//      opened) with a slow poll as a safety net.
//   2. Raises the in-app banner, which is the only alert the user reliably sees
//      when they are already looking at the planner.
//   3. Owns the push subscription: asks for permission, registers with the
//      server, and re-registers on every load so a rotated or dropped
//      subscription repairs itself instead of failing silently for weeks.
//   4. Keeps the offline plan in the service worker fresh, which is what lets
//      the phone still alert while the PC is hibernating.

export interface PushDevice {
  id: string;
  endpoint: string;
  label?: string;
  deviceId?: string;
  userAgent?: string;
  createdAt: number;
  lastOkAt?: number;
  lastErrorAt?: number;
  lastError?: string;
  failures?: number;
}

export interface NotificationHealth {
  windowsToast: { lastOkAt?: number; lastErrorAt?: number; lastError?: string };
  push: PushDevice[];
  lastTickAt: number;
  lastWakeAt?: number;
  scheduledNext?: { key: string; title: string; fireAt: number } | null;
}

export type PushState =
  | 'unsupported'   // no service worker or no push manager (a desktop browser in a private window, an old iOS)
  | 'denied'        // the user said no; only browser settings can undo this
  | 'default'       // never asked
  | 'subscribing'
  | 'subscribed'
  | 'error';

// ─── Sound ───────────────────────────────────────────────────────────────────

let audioCtx: AudioContext | null = null;

function ctx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  try {
    const Ctor = window.AudioContext || (window as any).webkitAudioContext;
    if (!Ctor) return null;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

/** Unlock audio on the first gesture, or the alert tone is silently dropped. */
export function primeNotificationAudio(): void {
  const c = ctx();
  if (!c) return;
  try {
    const g = c.createGain();
    g.gain.value = 0.0001;
    g.connect(c.destination);
    const o = c.createOscillator();
    o.connect(g);
    o.start();
    o.stop(c.currentTime + 0.01);
  } catch { /* nothing to unlock */ }
}

function tone(c: AudioContext, freq: number, start: number, dur: number, gain: number, type: OscillatorType = 'sine') {
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, c.currentTime + start);
  g.gain.setValueAtTime(0.0001, c.currentTime + start);
  g.gain.exponentialRampToValueAtTime(gain, c.currentTime + start + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
  osc.connect(g);
  g.connect(c.destination);
  osc.start(c.currentTime + start);
  osc.stop(c.currentTime + start + dur + 0.05);
}

/**
 * Two distinct sounds, on purpose. A routine reminder is a soft rising pair; a
 * critical one is an insistent triple that does not sound like anything else
 * the app plays, so it is recognisable without looking at the screen.
 */
export function playAlertSound(priority: 'normal' | 'critical'): void {
  const c = ctx();
  if (!c) return;
  try {
    if (priority === 'critical') {
      tone(c, 880, 0, 0.16, 0.16, 'triangle');
      tone(c, 1174, 0.18, 0.16, 0.16, 'triangle');
      tone(c, 880, 0.36, 0.28, 0.14, 'triangle');
    } else {
      tone(c, 587, 0, 0.14, 0.1);
      tone(c, 880, 0.13, 0.26, 0.09);
    }
  } catch { /* audio is a nicety, never a dependency */ }
}

// ─── Server calls ────────────────────────────────────────────────────────────

const postJson = async (url: string, body: unknown): Promise<any> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} responded ${res.status}`);
  return res.json().catch(() => ({}));
};

const b64ToUint8 = (base64: string): Uint8Array => {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
};

/** A readable name for the device list in settings. */
function describeThisDevice(): string {
  if (typeof navigator === 'undefined') return 'Unknown device';
  const ua = navigator.userAgent;
  const platform = /Android/i.test(ua) ? 'Android'
    : /iPhone|iPad|iPod/i.test(ua) ? 'iPhone or iPad'
    : /Windows/i.test(ua) ? 'Windows'
    : /Mac/i.test(ua) ? 'Mac'
    : 'Device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  const installed = typeof window !== 'undefined'
    && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone);
  const kind = getDeviceKind();
  const shape = kind === 'phone' ? 'phone' : kind === 'tablet' ? 'tablet' : '';
  return [platform, browser, installed ? 'installed app' : '', shape].filter(Boolean).join(', ');
}

/** Installed as an app? Android grants an installed PWA the periodic wake-up. */
export function isInstalledApp(): boolean {
  if (typeof window === 'undefined') return false;
  return !!(window.matchMedia?.('(display-mode: standalone)').matches
    || window.matchMedia?.('(display-mode: fullscreen)').matches
    || (navigator as any).standalone);
}

// ─── The hook ────────────────────────────────────────────────────────────────

export interface UseNotifications {
  store: NotificationStore;
  active: NotificationRecord[];
  grouped: Array<{ label: string; items: NotificationRecord[] }>;
  unread: number;
  /** The newest alert that has not been shown in-app yet. */
  banner: NotificationRecord | null;
  dismissBanner: () => void;

  markRead: (keys: string[]) => void;
  markUnread: (keys: string[]) => void;
  markAllRead: () => void;
  snooze: (keys: string[], minutes: number) => void;
  acknowledge: (keys: string[]) => void;
  complete: (keys: string[]) => void;
  clear: (keys: string[]) => void;
  clearAll: () => void;

  /** Feed one `notifications` frame from the page's existing db-stream. */
  adoptStreamFrame: (raw: string) => void;

  permission: NotificationPermission | 'unsupported';
  pushState: PushState;
  pushError: string | null;
  enablePush: () => Promise<void>;
  disablePush: () => Promise<void>;

  health: NotificationHealth | null;
  refreshHealth: () => Promise<void>;
  sendTest: (priority?: 'normal' | 'critical') => Promise<void>;
}

export function useNotifications(options: { soundEnabled?: boolean; inAppEnabled?: boolean } = {}): UseNotifications {
  const { soundEnabled = true, inAppEnabled = true } = options;

  const [store, setStore] = useState<NotificationStore>({ items: {}, updatedAt: 0 });
  const [banner, setBanner] = useState<NotificationRecord | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );
  const [pushState, setPushState] = useState<PushState>('default');
  const [pushError, setPushError] = useState<string | null>(null);
  const [health, setHealth] = useState<NotificationHealth | null>(null);

  const storeRef = useRef(store);
  storeRef.current = store;
  /** Last alert instant seen per key, so an escalation counts as a new alert. */
  const seenRef = useRef<Map<string, number>>(new Map());
  const primedRef = useRef(false);
  const streamAliveRef = useRef(0);
  const soundRef = useRef(soundEnabled);
  soundRef.current = soundEnabled;
  const inAppRef = useRef(inAppEnabled);
  inAppRef.current = inAppEnabled;

  /**
   * Adopt a new store. The first adoption only records a baseline: without that
   * step, opening the planner would fire a banner for every notification that
   * arrived while it was closed, all at once.
   */
  const adopt = useCallback((next: NotificationStore) => {
    const first = !primedRef.current;
    primedRef.current = true;

    let freshest: NotificationRecord | null = null;
    const now = Date.now();

    for (const rec of Object.values(next.items)) {
      const seen = seenRef.current.get(rec.key);
      const alertAt = rec.lastAlertAt ?? rec.firedAt;
      seenRef.current.set(rec.key, alertAt);
      if (first) continue;
      if (seen !== undefined && alertAt <= seen) continue;
      if (rec.read || rec.missed || rec.completed) continue;
      if (rec.snoozedUntil && rec.snoozedUntil > now) continue;
      // Only genuinely recent alerts raise a banner. Anything older arrived
      // while this window was closed and belongs in the centre, not on screen.
      if (now - alertAt > 2 * 60_000) continue;
      if (!freshest || alertAt > (freshest.lastAlertAt ?? freshest.firedAt)) freshest = rec;
    }

    // Drop keys that are gone, so the map cannot grow forever.
    for (const key of [...seenRef.current.keys()]) {
      if (!next.items[key]) seenRef.current.delete(key);
    }

    setStore(next);
    if (freshest && inAppRef.current) {
      setBanner(freshest);
      if (soundRef.current || freshest.priority === 'critical') playAlertSound(freshest.priority);
    }
  }, []);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications', { credentials: 'include' });
      if (!res.ok) return;
      adopt(coerceStore(await res.json()));
    } catch { /* offline; the stream or the next poll will catch up */ }
  }, [adopt]);

  const adoptStreamFrame = useCallback((raw: string) => {
    streamAliveRef.current = Date.now();
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const next = coerceStore(parsed);
      if (next.updatedAt && next.updatedAt === storeRef.current.updatedAt) return;
      adopt(next);
    } catch { /* malformed frame */ }
  }, [adopt]);

  useEffect(() => {
    void load();
    // A slow safety net only. It backs off entirely while the stream is live,
    // so a working stream costs nothing in requests.
    const id = window.setInterval(() => {
      if (Date.now() - streamAliveRef.current < 60_000) return;
      void load();
    }, 20_000);
    return () => window.clearInterval(id);
  }, [load]);

  // ── Actions ────────────────────────────────────────────────────────────────

  const act = useCallback(async (action: string, keys: string[], minutes?: number) => {
    // Applied locally first so the panel responds instantly; the server's copy
    // arrives moments later over the stream and overwrites this either way.
    setStore(prev => {
      const items = { ...prev.items };
      const now = Date.now();
      for (const key of (keys.length ? keys : Object.keys(items))) {
        const rec = items[key];
        if (!rec) continue;
        if (action === 'clear' || action === 'clear-all') delete items[key];
        else if (action === 'unread') items[key] = { ...rec, read: false, readAt: undefined };
        else if (action === 'snooze') items[key] = { ...rec, read: false, snoozedUntil: now + (minutes ?? 10) * 60_000 };
        else if (action === 'done') items[key] = { ...rec, read: true, readAt: now, completed: true, acknowledgedAt: now };
        else if (action === 'ack') items[key] = { ...rec, read: true, readAt: now, acknowledgedAt: now };
        else items[key] = { ...rec, read: true, readAt: now };
      }
      return { items, updatedAt: now };
    });

    setBanner(prev => (prev && (keys.length === 0 || keys.includes(prev.key)) ? null : prev));

    // Close the OS notification on this device straight away, rather than
    // waiting for the round trip back through the push service.
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      reg?.active?.postMessage({ type: 'planner-close-tags', tags: keys.map(notificationTag) });
    } catch { /* no worker in this context */ }

    try {
      await postJson('/api/notifications/action', { action, keys, minutes, deviceId: getDeviceId() });
    } catch {
      void load();
    }
  }, [load]);

  const markRead = useCallback((keys: string[]) => { void act('read', keys); }, [act]);
  const markUnread = useCallback((keys: string[]) => { void act('unread', keys); }, [act]);
  const markAllRead = useCallback(() => { void act('read-all', []); }, [act]);
  const snooze = useCallback((keys: string[], minutes: number) => { void act('snooze', keys, minutes); }, [act]);
  const acknowledge = useCallback((keys: string[]) => { void act('ack', keys); }, [act]);
  const complete = useCallback((keys: string[]) => { void act('done', keys); }, [act]);
  const clear = useCallback((keys: string[]) => { void act('clear', keys); }, [act]);
  const clearAll = useCallback(() => { void act('clear-all', []); }, [act]);

  // ── Push registration ──────────────────────────────────────────────────────

  const subscribe = useCallback(async (interactive: boolean) => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
      setPushState('unsupported');
      return;
    }
    if (Notification.permission === 'denied') {
      setPushState('denied');
      return;
    }
    if (Notification.permission === 'default' && !interactive) {
      // Asking without a gesture is refused by some browsers and annoying in
      // the rest, so a silent pass only repairs an already-granted permission.
      setPushState('default');
      return;
    }

    setPushState('subscribing');
    setPushError(null);
    try {
      if (Notification.permission !== 'granted') {
        const granted = await Notification.requestPermission();
        setPermission(granted);
        if (granted !== 'granted') {
          setPushState(granted === 'denied' ? 'denied' : 'default');
          return;
        }
      }

      const reg = await navigator.serviceWorker.ready;
      const { publicKey } = await fetch('/api/push/key', { credentials: 'include' }).then(r => r.json());
      if (!publicKey) throw new Error('the server has no push key');

      let sub = await reg.pushManager.getSubscription();
      // A subscription made against a different key can never be decrypted by
      // this server, so it is replaced rather than kept.
      if (sub) {
        const existing = new Uint8Array(sub.options.applicationServerKey || new ArrayBuffer(0));
        const wanted = b64ToUint8(publicKey);
        const same = existing.length === wanted.length && existing.every((b, i) => b === wanted[i]);
        if (!same) {
          await sub.unsubscribe().catch(() => {});
          sub = null;
        }
      }
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToUint8(publicKey) as unknown as BufferSource,
        });
      }

      const json = sub.toJSON();
      await postJson('/api/push/subscribe', {
        endpoint: json.endpoint,
        keys: json.keys,
        label: describeThisDevice(),
        deviceId: getDeviceId(),
        userAgent: navigator.userAgent,
      });
      setPushState('subscribed');

      // An installed app is allowed a periodic wake-up. This is the safety net
      // for the nights the PC is hibernating and cannot push anything at all.
      try {
        const periodic = (reg as any).periodicSync;
        if (periodic) {
          const status = await navigator.permissions?.query({ name: 'periodic-background-sync' as PermissionName }).catch(() => null);
          if (!status || status.state === 'granted') {
            await periodic.register('planner-notifications', { minInterval: 30 * 60 * 1000 }).catch(() => {});
          }
        }
      } catch { /* not supported here, and the push path still works */ }
    } catch (err) {
      setPushState('error');
      setPushError(String((err as Error)?.message || err));
    }
  }, []);

  const enablePush = useCallback(() => subscribe(true), [subscribe]);

  const disablePush = useCallback(async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      if (sub) {
        await postJson('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
        await sub.unsubscribe().catch(() => {});
      }
      setPushState('default');
    } catch (err) {
      setPushError(String((err as Error)?.message || err));
    }
  }, []);

  // Repair the subscription on every load. This is the half of the
  // `pushsubscriptionchange` safety net that runs in the page, and it is what
  // stops the phone from going quiet weeks later with nothing to show for it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('Notification' in window)) { setPushState('unsupported'); return; }
    setPermission(Notification.permission);
    if (Notification.permission === 'granted') void subscribe(false);
    else if (Notification.permission === 'denied') setPushState('denied');
  }, [subscribe]);

  // ── Keep the offline plan fresh ────────────────────────────────────────────

  useEffect(() => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
    let cancelled = false;

    const refresh = async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const res = await fetch('/api/notifications/schedule?hours=30', { credentials: 'include' });
        if (!res.ok || cancelled) return;
        const plan = await res.json();
        reg.active?.postMessage({ type: 'planner-plan', plan });
        // Also ask it to fire anything that came due while this device was away.
        reg.active?.postMessage({ type: 'planner-check-plan' });
      } catch { /* offline; the worker keeps the plan it already has */ }
    };

    void refresh();
    const id = window.setInterval(refresh, 15 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [store.updatedAt]);

  // ── Messages from the worker ───────────────────────────────────────────────

  useEffect(() => {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data || {};
      if (data.type === 'planner-notification' || data.type === 'planner-open-notification') void load();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [load]);

  // ── Health ─────────────────────────────────────────────────────────────────

  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/health', { credentials: 'include' });
      if (res.ok) setHealth(await res.json());
    } catch { /* the panel simply shows nothing */ }
  }, []);

  const sendTest = useCallback(async (priority: 'normal' | 'critical' = 'normal') => {
    primeNotificationAudio();
    await postJson('/api/notifications/test', { priority });
    window.setTimeout(() => { void load(); }, 400);
  }, [load]);

  // ── Derived ────────────────────────────────────────────────────────────────

  const now = Date.now();
  const active = useMemo(() => activeNotifications(store, now), [store, now]);
  const all = useMemo(
    () => Object.values(store.items).sort((a, b) => b.firedAt - a.firedAt),
    [store],
  );
  const grouped = useMemo(() => groupNotifications(all, now), [all, now]);

  return {
    store,
    active,
    grouped,
    unread: active.length,
    banner,
    dismissBanner: () => setBanner(null),
    markRead, markUnread, markAllRead, snooze, acknowledge, complete, clear, clearAll,
    adoptStreamFrame,
    permission,
    pushState,
    pushError,
    enablePush,
    disablePush,
    health,
    refreshHealth,
    sendTest,
  };
}
