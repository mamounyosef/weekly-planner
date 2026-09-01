/**
 * Service worker — installability plus a cache that makes opening the planner
 * on a phone feel instant.
 *
 * What it caches, and why that is safe:
 *   • /assets/*        — content-hashed by the build. A given URL's bytes can
 *                        never change, so cache-first is correct forever.
 *   • icons, manifest  — artwork that changes about once a year.
 *   • the HTML shell   — fetched from the SERVER first, with the cached copy
 *                        as the fallback when the server cannot be reached in
 *                        time. See `shellFirst` for why it is that way round.
 *
 * What it never touches: anything under /api/. Every event, task, setting and
 * timer tick still comes live from the server, and the streaming endpoints are
 * passed through untouched — intercepting an SSE stream would break the live
 * sync between the phone, the desktop window and the widget.
 */
const VERSION = 'planner-v7';
const SHELL_CACHE = `${VERSION}-shell`;
const ASSET_CACHE = `${VERSION}-assets`;
const SHELL_URL = '/index.html';

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
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
}


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
/**
 * A hashed asset that is gone from the server means the page is running a shell
 * that no longer matches the build. Since the shell is fetched from the server
 * first now, this can only happen to a page that was already open when the
 * build moved, so the shell cache is thrown away and the page is reloaded onto
 * the current one. The message is sent as well for anything that would rather
 * handle it itself.
 */
async function recoverFromStaleShell() {
  if (recovering) return;
  recovering = true;
  await caches.delete(SHELL_CACHE);
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage({ type: 'planner-shell-updated' });
    try {
      await client.navigate(client.url);
    } catch (_) {
      // Some browsers refuse navigate() for a client they did not control from
      // the start. The message above is the fallback there.
    }
  }
  recovering = false;
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
 * How long the shell may take from the server before the cached copy is used.
 *
 * The shell is five kilobytes and the server is usually this same machine or a
 * device on the same network, so this is never reached in normal use. It exists
 * for the phone on a dead connection, where waiting is worse than opening a
 * build that is one version old.
 */
const SHELL_TIMEOUT_MS = 1500;

/**
 * The shell, fetched from the SERVER first and falling back to the cache.
 *
 * IT USED TO BE THE OTHER WAY ROUND, AND THAT WAS A TRAP. Cache-first painted
 * instantly and then refreshed in the background, which is the right trade for
 * a phone and the wrong one for a person who has just pressed reload to look at
 * a change they made. What it produced was a planner that showed the NEW build
 * on a hard reload and the OLD one on an ordinary F5, indefinitely: the shell
 * came from the cache, and every hashed asset it named was still in the asset
 * cache too, so the previous build went on running perfectly and invisibly.
 *
 * The background refresh was supposed to catch that and reload the page. It
 * could not be relied on: nothing held the worker alive while it ran, so the
 * browser was free to shut the worker down the moment the cached shell had been
 * handed over, killing the refresh before it wrote anything. And the message it
 * sent to say "the build moved" had no listener in the app at all.
 *
 * Serving a stale build silently is the worst outcome available here, so the
 * order is reversed: ask the server, and fall back to the cache only when the
 * server does not answer in time. The cached copy is still written on every
 * success, so the app opens offline exactly as it did before.
 */
async function shellFirst(request) {
  const cache = await caches.open(SHELL_CACHE);

  let timer = null;
  const fromNetwork = fetch(new Request(SHELL_URL, { cache: 'reload' }))
    .then(async (response) => {
      if (!response || !response.ok) return null;
      // Written back before it is returned, so the copy kept for offline use is
      // always the one most recently proven good.
      await cache.put(SHELL_URL, response.clone());
      return response;
    })
    .catch(() => null)
    .finally(() => { if (timer !== null) clearTimeout(timer); });

  const cached = await cache.match(SHELL_URL);
  if (!cached) {
    // Nothing to fall back to, so there is nothing to wait for either.
    return (await fromNetwork) || fetch(request);
  }

  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), SHELL_TIMEOUT_MS);
  });

  const winner = await Promise.race([fromNetwork, timeout]);
  return winner || cached;
}

/** Pure predicate for fetch routing: never intercept /api/, non-GET, text/event-stream, or third-party origins. */
function shouldHandleFetch(request, origin = (typeof self !== 'undefined' && self.location ? self.location.origin : '')) {
  if (!request || request.method !== 'GET') return false;
  let url;
  try {
    url = new URL(request.url, origin || 'http://localhost');
  } catch (_) {
    return false;
  }
  if (origin && url.origin !== origin) return false;
  if (url.pathname.startsWith('/api/')) return false;


  const accept = typeof request.headers?.get === 'function' ? request.headers.get('accept') : request.headers?.['accept'];
  if (accept === 'text/event-stream') return false;
  return true;
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  /** Paths the dev server answers itself; the worker must stay out of the way. */
  function isServerRoute(url) {
    const p = url.pathname.replace(/\/+$/, '');
    return p === '/app' || p === '/app.apk';
  }

  self.addEventListener('fetch', (event) => {
    const request = event.request;
    if (!shouldHandleFetch(request, self.location.origin)) return;

    let url;
    try {
      url = new URL(request.url);
    } catch (_) {
      return;
    }

    if (isImmutableAsset(url)) {
      event.respondWith(cacheFirst(request, ASSET_CACHE));
      return;
    }

    // Routes the SERVER owns, which must never be answered from the app shell.
    // Every navigation used to be served the cached single-page app, so opening
    // /app got index.html and the router's "no such route" page instead of the
    // installer -- in every browser, no matter how many times the server was
    // restarted. Anything added here must be a real server route.
    if (isServerRoute(url)) return;

    if (request.mode === 'navigate') {
      // waitUntil as well as respondWith: the response can settle on the cached
      // copy while the write-back of the fresh one is still in flight, and
      // without this the browser may stop the worker in between.
      const shell = shellFirst(request);
      event.respondWith(shell);
      event.waitUntil(shell.catch(() => {}));
      return;
    }

    if (isStaticFile(url)) {
      event.respondWith(staleWhileRevalidate(request, ASSET_CACHE));
    }
  });
}


/* ═══════════════════════════════════════════════════════════════════════════
   Notifications
   ═══════════════════════════════════════════════════════════════════════════

   This half of the worker is what makes a reminder arrive on a phone that has
   not had the planner open for days. It never depends on a page being alive.

   Two independent paths deliver:

     1. PUSH — the normal path. The server encrypts a message to this device and
        hands it to the push service, which delivers it over the channel the
        browser already keeps open with the OS. The worker is woken to show it.
        This works with the app closed, the browser closed, and the phone having
        been idle for days.

     2. THE CACHED PLAN — the fallback for when the SERVER is the thing that is
        off (the PC hibernates overnight). The page periodically stores the next
        day or so of scheduled reminders here. Whenever this worker is woken for
        any reason at all (a periodic sync, another push, a page load, a fetch),
        it checks that plan and fires anything now due. It cannot be as punctual
        as a push, so anything it fires says so, and it is reported back to the
        server the next time the phone can reach it so nothing fires twice.

   Every push shows a notification, without exception. Chrome revokes the push
   permission of a site that receives a push and stays silent, and losing the
   permission is exactly the silent failure this feature cannot afford.
*/

const NOTIFY_CACHE = `${VERSION}-notify`;
const PLAN_URL = '/__planner-notification-plan';
const FIRED_URL = '/__planner-locally-fired';

/**
 * Notification artwork, embedded rather than linked.
 *
 * Android fetches a notification's icon itself, at the moment it shows it,
 * outside this worker and outside the page. That fetch is one more thing that
 * can be slow or fail, and when it does the notification still appears but
 * with no icon at all. Embedding the bytes removes the fetch entirely, so the
 * artwork cannot be the part that fails. The same images exist as real files
 * under /notify/ for the Windows toast, which needs paths on disk.
 */
const NOTIFY_ART = {
  'event': {
    icon: 'data:image/png;base64,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',
    badge: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAEEklEQVR42u2bz4scRRTHP697AgYjuniSoJfgQRQvrmAQz5IckpuCvy7iwZMXzd+g6FGvOQTcQII3Lx5yihIxLAEPIijm4MmLC1kc3Z3p+XqYV2xtM72bnume7tmpLwzTM9XT9epb70fVezWQkJCQkJCQkDAfJJkkW5XnLpucXFLm14MmBuTEDMrXK6k5/p5JerJprZH0uKTToY9VIydozaakbyTdlfSZpDMxeQuQ/pGk7yV9J+niSpHkGmOSnpH0iw7jy2Bu85irv39YeuYDSa96n3nT42mD9dzMBLwGPAf8B+wBBXBB0oaZjReY8TcB+TP/BR4DXvc+Gx9Pmw5O/joViAP2GxjEKJJ94n0UbQ2ibbu1GZ9V0VbnmVbx2XqjQW4iswTK3MdkFYPLwm9r+oxcUiUJoc+KZ8rMJksl6IgOCxd4r6Jt6L+tK3B47nhG256ZjYFx2ybwUJpjZhNJnwPn3VGWVX4feBp43k0qtA+BbW+Pze1hZS2ATWCjZKr3gV+BR0rECzgN3DGzT4LsbROUm1kh6Q7wyooszX40s/NB9mVFsV2f0cIj1Ex/U2UqCwYWmxExJxV95S7r0sN8FhFTy9m2FC3zI/rLFhlkQiIoEdQaFvFBqthanKjJr0VQKU0xOGYLsH4aZGby5T7APyVN+gP4y2euS00ScAZ4oSsTC1pyv0TQp8BVD6tFh2Y1AV4CfmhCowcNzZgrmBWSrO5qtTHVmXY+OWIjnaJYCvOJoERQIigR1F4U6l05edATYkLqZBJ9LubNI58ogqI0aExGUWpbT4Ki/PYG8J6vgGGat75mZjtdkzToATnPAltMk/EB7wLvSHrLzH7rkqSsQ5+DpCeA607OPtOq6civN4Hrfk9nhxO6imJBIy65WY2Ylqjj18jbLvm9a0VQCOXnmF2KtmgjfG5G+9qsg3apTrSF73e7FLArgoLDvcW02pq7SYW07ci/G/o9UL9UvboEed4oM7N7wBXXlFOR1oTrK2Z2z+/tJMfUWZgPiS0z+0rSDvAx03o+wJ/AF2a2tbbroBJJW5JuAi96089mNlr7lXREUg6MzWw72rTmXZlV73bzgQg/V53H36Xd/AFJrZ41PBH5oD6iydJzSHZlHR7qzryymR0j61IIKv925Gay3+GEh4TbkMNH/wbRRtlcztYJ2ikJ8bak3zk4x6yOXMYE+MBX4mOX78GBq7Naci1yiPNl4CcOH8Hrg5NVNPFjv37fzK7Os3So7Sui0u42cC2aqRH9OP5iLksg5zZwY6kl8VB9kPSopK/VX9ySdDbIvEheZi6Sgj1LegO4DDzlZtZl6SYD/ga+BW6Y2bCzLcsq/EdrURmtISHynvESxlXUjVqt+6a09k5ISEhISEhISEhISDgW/wMYCOgppwl5QwAAAABJRU5ErkJggg==',
  },
  'task': {
    icon: 'data:image/png;base64,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',
    badge: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAGnUlEQVR42u2bW4hVVRjHf98+58yYl4LumRYlFJXVVEYhYfkSiA+V9lBKURkVQRmVpQYliN1EtIdSy4iKoMyohwqCCiOIIMhLWnQhq4d0KCnKypkzZ/97mG/R6uDgXM7aZ8T9wWbvfWafWd/+r//6bus7UEoppZRSSimllFJKKaWU0nKxVP9YUgZkCcdRdJ2bWX5IACSpAmBmjSJn2sc1oGFmGnUAScriWZQ0CTgdODkxg/YC35rZrhisVk2QtWr2zKwhqQbMBm4ALgCOAY5MTJ5/gF+Ar4CNwCYz+8MZlY+UTdZCcM4H1gAzItuTA32JAar4EWQLsNDMPm4VSCO2N5LmSOpWv/RJ6pGUq1jp8bElab+kByJnUTyDJFXNrE/StcDLwBigDtT8kf3ATmCrMymFZMBU4Gxggn9W988rwFIzeyzoWiRzMj93SfolmsEwe+sknSupWoAuVUlTJK2Q9JvrUI/YdE3M9qIAMkkdkj6KwMkl7Q4KxWCmPJrGmi7pC9ep18/fSzrOdbYi7c5Vkc3JJf0jaa7/rWOka3+ojJbU4dfnSfrZdaq7jo8EthW5vN5yJcLSetY/H9OutCAC6a5oqeWStkgam5xFETgTJf3gSuSS/pZ0litQJHNsgOU/wZeWJDUk7ZM0czgsGurLhOfPAI5272Turb41M6XKiQYC5wATYmb2J7A58mrjgCnDdZPDCQsmulut+/1WoFEEeyKWVoDMzPKmccMy2hIFqwCThhPaDPWF1HS2KJsuKlqtOkvvAF6XdKyDVI0opAPEXsPSrzpMBllRZZMm9tTMrC5pNvAEMBY4QdI8M/sxhQEuzKC2KOerS7oMeNXB2Q9MBzZJmpZisrJDBJyaJ8RTgZeA8UDD05seYBqwPAWTs0OIOZOBTcBpDk7Fz53ALmCx26bDh0HunXJJxwAvAmd6+aTiRrjitaB5ZrYtlDcOC4Ai193p1YKZDk41AuFv4GYz+zQsw0N2iQ3Fw/iz5vo9A8zymKvq7jr8r1vM7B0vZ9RT1VOKjHptkM+GmvJy4OYmcAIQi83sNWdOslpPlhoYSeaBW4eZaRDRduaFuCXAYjfENWdNDnQAy81spducpIWwLDFrqg7K7cAnkiZ71FsZ4Dud7s7nA4/6ywcde90ovwAs88g5eQSfpQLHE9e6pKXAOuBCYIOk8Q5CpbkyaGY9kuYAG3w5Zc6cPmfOa8DtJNj/KgygyN4cL2kVsMJfthe4Etgo6cim8kmob18MPOcBYAAoeK7NwD2+5Kyo3C8FgzJXvgu4118w2I4+90ir3AgrGFlPFd6MyigxONuBa81sjyejhe3athygaPl8ADwQeR/5dR24VdIaN74Nj5LX0r8LG+xOw5/fBcw3s73OtJwCJYkN8hnOzWylG9sYpJqDsNCP8c6caRFjGq7b786cHandebvcfM3MHnIjnbkdCuPmwDLgI+CiiGEhhfjLmfN5yMfaEdEnA8jtUMON9j2eaHZGSyjzkkUX/5VucweqAdxhZu+mSiFGBYOi7LoXuAl4P7JDOCBhOcVVwPvM7JWUKcSoSTUCSGb2F3Aj8KnboXiLmMj+rDazpzwQbNBmKSQXC9Gzme0GrgO+jEBqOMNqwNNmtiiA07aujBEA1Fy0Z4D7Ad2/mf0IzAO+d1AqHiO9AdwfakCjARwYftE+awKmMkgmBZC2SZoFPAicB7wFrKa/fEqLwKkc5D4JQEHxX+nv7Orw+6mDbTGJQPoGWBB/L8r8RxRd+PnspsnsLnKJfU1/qbPin50DTB7s3reDlHlfY5+kSovAcZzVAVzh9zWPqXYO1hyMdPSKA/Ge73uH5oUVoWTRLnvhPZJIur6p82S7pHGFtMCEHUxJC6IOioakvZIuDSAV0ovzf71CZ8dJkr5r6jx5PNY9efk06qDY2tRdtkNSV/Rs5oxLeWTReKdJ2tzU+tLtyTCFTVrURHW507gvalbqlnS3pKMKZM8RkuZJ2hW1vIRJuzWuPQ05hhsJSG5sFwFPetCnyLP9BHyId34kMo5VdxAz6N8zI0pjasBaM7uzbe3AUUVwSdT22xuxqUipR6yRpPWSxhyol7EQBkVrOnMmXQ2sov/nByERrZOuBTgOVWpRyLIHeBh4PrB2JMxpRad9DNKJwG3AXAdqfEFk3ueVx7eB9d4KMzp+itBsk/x6LHAJcCpwCmn7h/Z44PqZVwxo+08QDhICVNo4frXVrtxSAeVpSFHBokZLeaSUUkoppZRSSimllFJKKWUQ8i8pOZ03lzishwAAAABJRU5ErkJggg==',
  },
  'task-digest': {
    icon: 'data:image/png;base64,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',
    badge: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAEUElEQVR42u2aTWhcVRTHf2cmMZH60YCgRmuDoRuLddOFG7U0qBRBwUXduhHcKShCq9CN0uJG60oEV37goupKV+pCqKggElAhYLELtRYJsU01nczH38WcV65hambevI8Ezh8ud+bNe/ed93/nnHv+9w4EAoFAIBAIBAKBQCAQ2F6wsm8gqQE0gJ6Z9YLy/5JjA8gKOBlN7/dJelPSrkGkZcfKaludnJ2SFtXH95LultRMDffvjRJtmRiHKBuXCDPrDjom6TrgA+AR4G9gB/AdcMC/9w0wkxM6AxSZowzomNmFjCAz06iDTOTNLWYmJ8KSB2347zPAe8AhoOXkLAPPmNklv8bMrCdpP3AEuAPoFjxxrEs6ZWYnKw83d93HkhxyJXQkveNhddn7NUmPZ4k6yRG7JP2o8vF0Gvqlzkr+gFOSXvObv+LHJ520k368Jakj6R9Jh/36Ke8nvX8yIbBTQmtJ6ko6XTpBmZf45xMJCRlJ1yaktd1ASXoi87jU+7xf8DF6fn634LbuNry/0YYyiz4kHZL0h988M+Ib7zsJOUcGGZZ44oSkV52gsvCDpD156zDLQ5In14PAh8BOoA1M+izU8eT/kpkdlzRpZu1NxlwA9hSYpOXjXAY+MbPlbGKpus55IPGkNQ8tSTqR1Di1F2u1VPBJHjko6Xzi0m8nCduGJdzPL7rV+4ISkvZLekPSU0me2pplft3uu6U1UB3LHU7GhI/V9WUN5RijFFJrXWLZ6C15kmFWWW/VBG3j3Nin+2ngHuCsmZ0fZTpNz5V0U4FiVb5I1zKzS5UTlJCzF3gLuMvF6Atm9tEglX81ciTdD7wM3OwEFelNXeCUmR2rug7KtNfnGyTH78NUrclMt1vS2QrE6rN5tVienJG9iRngXq+cfwVWgVuB+SG8MzN0AdjtFW+3hLbu/eHMplHz3ejapB8WBqwAX/sMdjtwPXAOOJPkgashyzVngDVgepPzx0ETWErtr6z2kbRX0mlJK5J+TtZ8mkOMkcmVY5IulBRaPUnfSprLBPK2msWSse4D5jxcixSrbeAzM1upNEkXXQdVYWfdlXQDUN6q1cOtkbz5IjzoSr6LDcvANharaYyPkwTL0mOVJ+b/E5o5k3SzShvr8qAZYNXMOtn0P2KpMAXcQPE7q+tmdrFOsToLvO6SYQl43sy+GoakZIwHgePAnRS7aJ+J1XeBF112VFdJu1j9ONnqkaRfJN22WU5JdlfnJZ2rQKwerVqs9oAbgYf9zazQ/0PCHLBviLGb/iYPALfQ379XCa3t9j2adzIYR6xeBL4ErnGydgC/AUv++zBi9ScnZ8plRq/ghtu3WJdYnZf0qaRlF4UPDTubJWM8J+mvEsPrC0mzlYvV5EGnPbT+HHUHc8PK5CzF76y2gEUzW61LrDbGrWlK/0vKmIK4KLFqLlY1xgOUtbPRq7WaDgQCgUAgEAgEAoFAIBAIBAKBQIZ/AcwbvVNsEKRcAAAAAElFTkSuQmCC',
  },
  'prayer': {
    icon: 'data:image/png;base64,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',
    badge: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAFYklEQVR42u2bz2tcVRTHv2dm8kNa2qIu2k1t6CI2RcSiotR00e4UoQQ33bkoCK0S/AOKiIv+B91W3JVKF4LBjdBS/wFBdGGjQiGWCh1pG5tkfnxc5Lz28DJv8qbJZCbJ/cJw39z35tzzvvfcc+85946UkJCQkJCQkJAwcAAG2DDpVBkicqqdrhPccrzcA+yJdWlIPSPnAvCLfy4M65AbyLACZliLmWEYboP2QXh5VlJb0op/8Lr4zEBQGzBB2fD5zTurGup/zT2zK4dYxf3My8Ac0ALawA9eZ0BFuxnBD70I3AWWgNe9btAWPhTroLbPVC1JS16OeB2JIMnMDPc/1czneN32XUm7f6hucHiZpIrLqQSLeVq30XUQUN2IjNoGuh0fDs9LTFUSZtb0urrLQ9IjM2tJaoUXbD2PVbmcrZvmATMzgEOS3pf0vZndy+rLzFyueEbMK5IOSTom6SVJo5I+BPZK+sfM/ooznpm1e9DxoKQPJM2Z2d9lddzw1OzlNPAEOFlmxRunbL+eAb4B5inGvD8zE0KSdYddmBlPuo7TUfetWLtUgPeABeBd/14tSc4p4BbQDEQ0S3y/BZwqQ5IPy4rrtuC6VraKoFEvjwP3gKlYXxSQAqPAJWDZX7oFrITFYR7t3DP4by+5rMJANug45Toe76ZjPxZ1R4GvgIfAl8DhTimKYG3jwNXw4s0CUoqQ/81Vl7nGKsJQPOy6PXRdj/Y1+A1D5LyveCP+BM7lSLRwfSVYQC/EdCIqs8Ar+Wk8tHfOdYq4C5zviy8KDZ/O+QWAhpcPgsOuhd/M+v0VNg+ZrNlAUi045gc53aI/O72plpQ5WFfiZsHLLnl5HRhxggw4Bjzu4mc2Ykktl33M26p529dzOuVJvRmcuG2m9ZwA6kHBvMKZFU2G397o0IObhUzmjdDeZLCeIh3rwImyVlRmLGYLqwVJn0ua93iJcD/L38xKqnvj70g644mwfkyvFZd9xtuStz3runTScd7fYaFvyTjgdpimY0/O+f0xLy/3wfcU+aLLubbncrplut7uW7Dq43xM0kjBI+M+OzSAfZKmtyBjkMme9jYbrsN4wfMjwFgvvqe08h7DNLuYZdvM2h4rHZH0WjDtfqZs8baOhPbbXdxFs5d4rF+9e1DSPo/O+21BLW/r4HZKmE0MILc1sZ0IGhsAQWPbiaD2AAhqbyeCdgyGjSA0BDsZw0hQKywJsqm7lQh6Rk41hAp1v64OA0mDJqjtRPyk1cMKr/rnrNdVB+Twn6I2YHIqkr6V9LGZLYZ73wE/Svpa0kd9DHiH1oLaIQNw0cwWPZeT5a9HnLCLITJv7yaCWv7S18zsPjBqZg0zwz8Nr7sv6Zo/29pNBGXt3vHIupN1ZIca7gxS10E0SocsgXVOIKyJutktFpRW0omgRFBCImgzV9Lh0FNRjjmeOCu7a5mdCqkC+ak+qyvbidXQfqGOmdyyeemeQg0zWwGaBbcb2WkuYLGkyOXsJFnBYlLAcklZi6H9RsEzTTNbyTq8DEm1HsgBeEOrCfLYS1m5H3jTv0906UkLVjHpu5zjWt0xyeu2JGkyuIMieZI0Abzla6X9BTruBd6W9LOZLZchyUoMrexlLkn6RNIBrR6TW9M7kv716z2SXtD62z6PJT3pMiRbLmfvOgtPczmZ5R4o6PwVSY8kzUn6VNJ/YbHaO0Fhg+2Apx+mdojvbUqaMrPfgUq3c4+1EsOqYmZ14AtJn2l198DWCSN62Sxczw88jyzrkkXAA+A/yhwK7WnXE9jvpLKNrQczq/fiqMuSs2P+JtnLCbNeLWhH/DVpWP7mkJCQkJCQkJCQkLBz8T+wEZAwKPAQWQAAAABJRU5ErkJggg==',
  },
  'critical': {
    icon: 'data:image/png;base64,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',
    badge: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEgAAABICAYAAABV7bNHAAAF2klEQVR42u2aXYhVVRTH/+uemVGT1CIjxCgNrDEo+9A+SESJAn0Q7MEIoiSCdCRCwkDzpSSiD7AHCcp86KF8iII+qIzCHpKkD0pqoCxEpFImdcqv0bn3/nqYdWBxus7ce70z3jv3/OGwD2efs8/Za//Xf6+99pFy5MiRI0eOHDly5MiRY3wDKACF3BI5amaO+TEDmOvnOZOCgTq93AZ85ecdgOXGgQ4v5wP9DGFFrGt310qACcC7bpwSsBeY2vaiDSRergCKwKAfABvjPe0szFOA3sCetOwHZretYAftedaNUvSyHM7fbksWBde6CTjmRin5UQ5GGgSWtp2RXJiTIMyp7qTn5XDta2CyC7a1E3uWOWOKwRivAZuCoVJXW90WLEoF1xnxvXf+rBuqD5jldb8EFpWBw8DMtI12YM+GIMwpezaH+x4J7EpZtD2Nm8az7hgwBzjiBkiN0wtMd3algePnGVc7BSwelxF2iJgNeKuCxqz0+yYAXb4Oux0YyBhyJ3BR2tZ4dK3FFYT5/WGe21LBFVeNpWDbGBmoIKlL0peSFkgq+rv/kbRQ0gFJSyV1SipLmiRpt6TjkvZImuHXOyQdlHSzpCOSZGaMl4h5XVhGnPXzF73ueuBEZrmxzuvWBpdM616OaZLx4FqzgD+CccrAr8BM16Vun+ZLLsZloMfrJgG7M7p1FFjQ8oLtYtoBvB5inlSYHwr3XQv87YYZ8HJNqL8nLEVSLfrIjdeagh3YcxdwJhPTfJpO6cFAR7zujJdrM9nG7UGwi26sFS0bYbsBOoBdmY6dAG7NdL6SgXq8rstdbRZwyNmVatjPni6x0WJRYbSE2czKkh6VtMhnICQlkraZ2bc+6qUqmitJSsxsv6RXfPYzvz5X0nqfyZJW0p0CcBWwP6ypSsAB4MoQOBaqYFASIuyLPR0bV/19YSckaQUGmbNlvaSrfaTN3/W8mR2UVDCzUtUNDrERMzsuaZO3X/C2L5P09FjFdI0S5oXAyYww73JNKmQCyBEZVOH+9zKx0SCwrOkFO92FAD7LpDIGgDuH6XDVBnJXutFz1jGx9p2v5QpN6WJA4q7woKS7XZgLfmw3s90e1JXr9t2h9hMz+1HS1uBWJV9+9JhZuelYFJgzA/g9I6J/umD/T0QzDMoGij2VXCYk3aZ7NB7f9ZfvhBQaZaRGMajgo/ukpNlhMWqSXjKzAyMIM+Eoh2uVWMRQYX2Sngv9KEm6QtJT/i3WFBF2YMF84HhmObDHA73CCM92+7Nxsfr4cKIbWPtJRu9OA3c0jWCHRNiHmQXlaWDJCJ00L6cA9wEPAPcDDwNzhstBhxnzNp8x48DsAjov+IZj+MiVFVIZbzRSC84Vsfs7tjbdTkig+LQKuxCHgOuqjW79vgk+6p3VTteBvZWi9t+Ayy/Y1nVgz+YKo7exllxN0KLJwOR4rYaE3OrA4tTVXrggLArGuQH4N5Mz/sET61XNIkGH1gA/+bFmOP05B5u7fBc2Zg5OhsxBMqbu5eU7gT2Drj9V76UHQ6/i/1hVRztLKuWeamFkI9mzvEKW700XzqSW9jwcSAU+na731NFOksleljLbSslYCfNUd6X440G//63RAUz0srOKowv4IuMa+LWuKttI39npG5N9mQi71wV7dP9YC4K4IZNjHkx3Iepsdx6wLzByHzDvPNp7LLPSB3imniS/1cIeXwh2a2h/61KvSiQd9WXGmTrzRwOS5kt6wq9tkfSNpInnWnKMgA5v45KQtTwmaZGZ9aZ9GS3t2ZH5Iyx7Xi9OBRc71YD2ShW+b0etWlTtNJqYWQm4V9LHIZURUa5ztOOoRxTPM6tZ6fsKkpab2Qdpn87bQB6LFCRNlbRT0i1qbeyVtFhD297lkbauqxGsxMyKPlV2SzrsumMVUhaNyGc3uq34fSVJ10haaWavumAXG+FiJmmaG4aQmG8lWEj2FyX1t/yPD81iVdXAovHT8Zw9OXLkyJEjR44cOXLkyNG0+A8neq/FQvq0PgAAAABJRU5ErkJggg==',
  },
};

/** Artwork per kind. A prayer reminder should not look like a calendar entry. */
function artFor(kind, priority) {
  const name = priority === 'critical' ? 'critical' : (kind || 'event');
  // The URL form stays as the fallback: if this worker is ever served with the
  // embedded block stripped, an icon over the network still beats no icon.
  return NOTIFY_ART[name] || NOTIFY_ART.event
    || { icon: `/notify/icon-${name}.png`, badge: `/notify/badge-${name}.png` };
}

async function cacheReadJson(url, fallback) {
  try {
    const cache = await caches.open(NOTIFY_CACHE);
    const hit = await cache.match(url);
    return hit ? await hit.json() : fallback;
  } catch (_) {
    return fallback;
  }
}

async function cacheWriteJson(url, value) {
  try {
    const cache = await caches.open(NOTIFY_CACHE);
    await cache.put(url, new Response(JSON.stringify(value), {
      headers: { 'Content-Type': 'application/json' },
    }));
  } catch (_) { /* a full disk must not break delivery */ }
}

/** Build the OS notification for one record. Shared by push and the fallback. */
function optionsFor(n, extra) {
  const art = artFor(n.kind, n.priority);
  const critical = n.priority === 'critical';
  const actions = [];

  // Android shows at most two action buttons, so the two chosen here are the
  // ones that end the interaction: stop it shouting, or deal with it.
  if (critical) {
    actions.push({ action: 'ack', title: 'Acknowledge' });
  } else {
    const snooze = (extra && extra.snoozeOptions && extra.snoozeOptions[0]) || 10;
    actions.push({ action: `snooze:${snooze}`, title: `Snooze ${snooze}m` });
  }
  if (n.kind === 'task' || n.kind === 'event') {
    actions.push({ action: 'done', title: 'Done' });
  } else {
    actions.push({ action: 'read', title: 'Mark read' });
  }

  return {
    body: n.body || '',
    tag: `planner:${n.key}`,
    icon: art.icon,
    badge: art.badge,
    // Critical alerts must survive being missed: they stay on screen and are
    // re-announced even when they replace an earlier copy of themselves.
    requireInteraction: critical,
    renotify: true,
    silent: false,
    timestamp: n.fireAt || Date.now(),
    vibrate: critical ? [200, 100, 200, 100, 400] : [120, 60, 120],
    data: {
      key: n.key,
      kind: n.kind,
      url: n.url || '/',
      priority: n.priority,
      local: !!(extra && extra.local),
    },
  };
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  self.addEventListener('push', (event) => {
    event.waitUntil((async () => {
      let payload = null;
      try {
        payload = event.data ? event.data.json() : null;
      } catch (_) {
        payload = null;
      }

      // A push that cannot be read still has to show something. Staying silent
      // here is what gets the push permission revoked.
      if (!payload) {
        await self.registration.showNotification('Daily Planner', {
          body: 'You have a reminder waiting. Open the planner to see it.',
          tag: 'planner:unknown',
          icon: '/notify/icon-event.png',
          badge: '/notify/badge-event.png',
          data: { url: '/?notifications=1' },
        });
        return;
      }

      // Something was dealt with on another device: take it off this screen too.
      if (payload.type === 'dismiss') {
        const tags = payload.tags || [];
        const open = await self.registration.getNotifications();
        for (const notification of open) {
          if (tags.includes(notification.tag)) notification.close();
        }
        await markPlanHandled(payload.keys || []);
        return;
      }

      if (payload.type === 'plan') {
        await cacheWriteJson(PLAN_URL, payload.plan);
        return;
      }

      const n = payload.n;
      if (!n) return;

      // The server has this one, so the offline fallback must not fire it again.
      await markPlanHandled([n.key]);
      await self.registration.showNotification(n.title || 'Daily Planner', optionsFor(n, payload));


      // Any window that is open should raise its own in-app banner rather than
      // relying on the OS notification the user may not be looking at.
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'planner-notification', payload });
    })());
  });

  self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data || {};
    const action = event.action || 'open';
    event.notification.close();

    event.waitUntil((async () => {
      if (action.startsWith('snooze:')) {
        await sendAction({ action: 'snooze', keys: [data.key], minutes: Number(action.split(':')[1]) || 10 });
        return;
      }
      if (action === 'done' || action === 'read' || action === 'ack') {
        await sendAction({ action, keys: [data.key] });
        return;
      }

      // Plain tap: reaching the item counts as dealing with it.
      await sendAction({ action: 'read', keys: [data.key] });

      const url = new URL(data.url || '/', self.location.origin);
      url.searchParams.set('notifications', '1');
      if (data.key) url.searchParams.set('open', data.key);

      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'planner-open-notification', key: data.key, url: url.pathname + url.search });
          return client.focus();
        }
      }
      return self.clients.openWindow(url.pathname + url.search);
    })());
  });
}


/** Actions taken offline are queued, so a snooze on the train is not lost. */
async function sendAction(body) {
  try {
    const res = await fetch('/api/notifications/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ ...body, deviceId: 'service-worker' }),
    });
    if (res.ok) return true;
  } catch (_) { /* offline */ }

  const queue = await cacheReadJson('/__planner-action-queue', []);
  queue.push({ ...body, queuedAt: Date.now() });
  await cacheWriteJson('/__planner-action-queue', queue.slice(-100));
  return false;
}

async function flushActionQueue() {
  const queue = await cacheReadJson('/__planner-action-queue', []);
  if (!queue.length) return;
  const left = [];
  for (const item of queue) {
    try {
      const res = await fetch('/api/notifications/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...item, deviceId: 'service-worker' }),
      });
      if (!res.ok) left.push(item);
    } catch (_) {
      left.push(item);
    }
  }
  await cacheWriteJson('/__planner-action-queue', left);
}

/** Drop keys from the cached plan so the fallback cannot repeat them. */
async function markPlanHandled(keys) {
  if (!keys || !keys.length) return;
  const plan = await cacheReadJson(PLAN_URL, null);
  if (!plan || !Array.isArray(plan.items)) return;
  const drop = new Set(keys);
  plan.items = plan.items.filter((i) => !drop.has(i.key));
  await cacheWriteJson(PLAN_URL, plan);
}

/**
 * Core logic of cached plan execution: filters due items in [now - 6h, now],
 * fires them, and separates remaining unexpired items.
 */
async function runCachedPlanCore(plan, now, showNotificationFn) {
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) return { fired: [], remaining: [] };
  const floor = now - 6 * 60 * 60 * 1000;
  const due = plan.items.filter((i) => i.fireAt <= now && i.fireAt > floor);
  if (!due.length) return { fired: [], remaining: plan.items.filter((i) => i.fireAt > floor) };

  const firedKeys = [];
  for (const n of due) {
    if (showNotificationFn) {
      await showNotificationFn(n.title || 'Daily Planner', optionsFor(n, {
        local: true,
        snoozeOptions: (plan.settings && plan.settings.snoozeOptions) || [5, 10, 30],
      }));
    }
    firedKeys.push(n.key);
  }

  const remaining = plan.items.filter((i) => !firedKeys.includes(i.key) && i.fireAt > floor);
  return { fired: firedKeys, remaining };
}

/**
 * Fire anything in the cached plan that is now due. This is the path that runs
 * when the PC is asleep, so it is deliberately conservative: it only fires
 * things that came due recently, and it marks them as fired locally so the
 * server can reconcile rather than sending a duplicate later.
 */
async function runCachedPlan() {
  const plan = await cacheReadJson(PLAN_URL, null);
  if (!plan || !Array.isArray(plan.items) || !plan.items.length) return 0;

  const now = Date.now();
  const { fired, remaining } = await runCachedPlanCore(plan, now, (title, opts) => self.registration.showNotification(title, opts));
  if (!fired.length) return 0;

  await cacheWriteJson(PLAN_URL, { ...plan, items: remaining });

  // Tell the server as soon as it can be reached, so it does not send these
  // again the moment it wakes up. Failing here is fine: the record is kept.
  const pending = await cacheReadJson(FIRED_URL, []);
  const merged = [...new Set([...pending, ...fired])].slice(-200);
  await cacheWriteJson(FIRED_URL, merged);
  await reportLocallyFired();

  return fired.length;
}

async function reportLocallyFired() {
  const keys = await cacheReadJson(FIRED_URL, []);
  if (!keys.length) return;
  try {
    const res = await fetch('/api/notifications/local-fired', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ keys, deviceId: 'service-worker' }),
    });
    if (res.ok) await cacheWriteJson(FIRED_URL, []);
  } catch (_) { /* still offline; the list is kept for next time */ }
}

/** Refresh the cached plan from the server whenever it is reachable. */
async function refreshPlan() {
  try {
    const res = await fetch('/api/notifications/schedule?hours=30', { credentials: 'include' });
    if (!res.ok) return false;
    const plan = await res.json();
    await cacheWriteJson(PLAN_URL, plan);
    return true;
  } catch (_) {
    return false;
  }
}

if (typeof self !== 'undefined' && typeof self.addEventListener === 'function') {
  // Chrome grants installed apps a periodic wake-up. It is not punctual enough to
  // be the primary transport, but it is exactly right as the safety net: it keeps
  // the cached plan fresh and fires anything the sleeping PC could not.
  self.addEventListener('periodicsync', (event) => {
    if (event.tag !== 'planner-notifications') return;
    event.waitUntil((async () => {
      await flushActionQueue();
      await reportLocallyFired();
      const refreshed = await refreshPlan();
      if (!refreshed) await runCachedPlan();
      else await runCachedPlan();
    })());
  });

  self.addEventListener('sync', (event) => {
    if (event.tag !== 'planner-notifications') return;
    event.waitUntil((async () => {
      await flushActionQueue();
      await reportLocallyFired();
      await refreshPlan();
    })());
  });

  self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'planner-plan') {
      event.waitUntil(cacheWriteJson(PLAN_URL, data.plan));
    } else if (data.type === 'planner-check-plan') {
      event.waitUntil((async () => {
        await flushActionQueue();
        await reportLocallyFired();
        await runCachedPlan();
      })());
    } else if (data.type === 'planner-close-tags') {
      event.waitUntil((async () => {
        const open = await self.registration.getNotifications();
        for (const notification of open) {
          if ((data.tags || []).includes(notification.tag)) notification.close();
        }
      })());
    }
  });

  /**
   * A push subscription can be rotated by the browser at any time. Not handling
   * this is the classic way phone notifications stop working weeks later with no
   * visible cause: the server keeps pushing to an endpoint nobody is listening to.
   */
  self.addEventListener('pushsubscriptionchange', (event) => {
    event.waitUntil((async () => {
      try {
        const old = event.oldSubscription || await self.registration.pushManager.getSubscription();
        const key = event.newSubscription
          ? null
          : await fetch('/api/push/key', { credentials: 'include' }).then((r) => r.json()).then((b) => b.publicKey);

        const sub = event.newSubscription || await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key,
        });

        if (old && old.endpoint && old.endpoint !== sub.endpoint) {
          await fetch('/api/push/unsubscribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ endpoint: old.endpoint }),
          }).catch(() => {});
        }

        const json = sub.toJSON();
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            endpoint: json.endpoint,
            keys: json.keys,
            label: 'Re-registered automatically',
          }),
        });
      } catch (_) {
        // Nothing further can be done from here. The page re-subscribes on its
        // next load, which is the other half of this safety net.
      }
    })());
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VERSION,
    isImmutableAsset,
    isStaticFile,
    shouldHandleFetch,
    NOTIFY_ART,
    artFor,
    optionsFor,
    runCachedPlanCore,
  };
}

