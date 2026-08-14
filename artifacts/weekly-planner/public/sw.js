/**
 * Minimal service worker — the only reason it exists is installability.
 *
 * Chrome on Android only offers a real "Install app" (its own window, no URL
 * bar) when the page has a manifest AND a service worker with a fetch handler.
 * Without one, "Add to home screen" makes a plain shortcut that still opens in
 * a browser tab with the address bar showing.
 *
 * It deliberately caches NOTHING: the planner talks to a live dev server for
 * every event, task and setting, and a stale cached shell would show old data
 * or an old build after every code change. Requests are passed straight
 * through, so this is a no-op apart from making the app installable.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});
