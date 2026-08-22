/**
 * Service worker — installability plus a cache that makes opening the planner
 * on a phone feel instant.
 *
 * What it caches, and why that is safe:
 *   • /assets/*        — content-hashed by the build. A given URL's bytes can
 *                        never change, so cache-first is correct forever.
 *   • icons, manifest  — artwork that changes about once a year.
 *   • the HTML shell   — served from cache immediately, then refreshed in the
 *                        background. A new build is picked up on the same load
 *                        (see the reload message below), not the next one.
 *
 * What it never touches: anything under /api/. Every event, task, setting and
 * timer tick still comes live from the server, and the streaming endpoints are
 * passed through untouched — intercepting an SSE stream would break the live
 * sync between the phone, the desktop window and the widget.
 */
const VERSION = 'planner-v2';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL_URL = '/index.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.add(new Request(SHELL_URL, { cache: 'reload' })))
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  // Drop every cache from an older VERSION, so a format change here can never
  // leave the phone serving something this code no longer understands.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

/** Hashed build output: identical URL always means identical bytes. */
const isImmutableAsset = (url) => url.pathname.startsWith('/assets/');

/** Unhashed static artwork: fine to show instantly, worth refreshing quietly. */
const isStaticFile = (url) =>
  /\.(png|ico|svg|webmanifest|txt|woff2?)$/i.test(url.pathname);

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request).catch(() => null);
  if (response && response.ok) {
    cache.put(request, response.clone());
    return response;
  }
  // A hashed asset that is neither cached nor on the server means the cached
  // shell is pointing at a build that no longer exists — the one way this
  // strategy could hand the user a blank screen. Throw the shell away and
  // reload so the next navigation fetches the current one from the server.
  if (response && response.status === 404) await recoverFromStaleShell();
  return response || Response.error();
}

let recovering = false;
async function recoverFromStaleShell() {
  if (recovering) return;
  recovering = true;
  await caches.delete(SHELL_CACHE);
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) client.postMessage({ type: 'planner-shell-updated' });
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return hit || (await network) || fetch(request);
}

/**
 * The shell, served from cache first so the app paints without waiting for the
 * network at all. The background copy is compared against what was served; if
 * the build changed, open pages are told to reload themselves once, so a fresh
 * deploy still lands on the very next open rather than the one after it.
 */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);
  const cached = await cache.match(SHELL_URL);

  const refresh = fetch(new Request(SHELL_URL, { cache: 'reload' }))
    .then(async (response) => {
      if (!response.ok) return;
      const fresh = await response.clone().text();
      const previous = cached ? await cached.clone().text() : null;
      await cache.put(SHELL_URL, response);
      if (previous !== null && previous !== fresh) {
        const clients = await self.clients.matchAll({ type: 'window' });
        for (const client of clients) client.postMessage({ type: 'planner-shell-updated' });
      }
    })
    .catch(() => {});

  // The refresh above is deliberately not awaited here: the page must not wait
  // on the network when a usable shell is already on the device.
  if (cached) return cached;
  await refresh;
  return (await cache.match(SHELL_URL)) || fetch(request);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  // Anything not served by this app (Google Fonts, for instance) and every API
  // call — including the long-lived streams — is left completely alone.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;
  if (request.headers.get('accept') === 'text/event-stream') return;

  if (isImmutableAsset(url)) {
    event.respondWith(cacheFirst(request, ASSET_CACHE));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(shellFirst(request));
    return;
  }

  if (isStaticFile(url)) {
    event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
  }
});
