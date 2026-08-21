import { createRoot } from 'react-dom/client';

import App from './App';

import './index.css';

// Chrome stores cookies per host. `localhost` and `127.0.0.1` both reach this
// computer, but they are different cookie sites. The native widget is allowed
// to stay on 127.0.0.1 because it has its own pairing flow; every ordinary
// browser visit is normalised to the main app's canonical localhost address so
// the persistent sign-in is always found on the next launch.
const params = new URLSearchParams(window.location.search);
const HANDOFF_HASH_KEY = 'planner-host-handoff';
const HANDOFF_TICKET_RE = /^[a-f0-9]{64}$/;
const isNativeWidget = params.has('widgetSession');
const isOAuthCallback = params.has('code') || params.has('state') || params.has('error');

function canonicalUrl(): URL {
  const url = new URL(window.location.href);
  const port = window.location.port ? `:${window.location.port}` : '';
  url.host = `localhost${port}`;
  return url;
}

async function moveLegacyBrowserSession() {
  const url = canonicalUrl();
  try {
    // The old 127.0.0.1 cookie is HttpOnly and never read by JavaScript. This
    // endpoint converts it to a one-time, 30-second ticket that is consumed by
    // localhost below; the real cookie stays confined to browser requests.
    const response = await fetch('/api/auth/host-handoff', {
      headers: { 'Cache-Control': 'no-cache' },
    });
    const data = response.ok ? await response.json() : null;
    if (typeof data?.ticket === 'string' && HANDOFF_TICKET_RE.test(data.ticket)) {
      url.hash = `${HANDOFF_HASH_KEY}=${data.ticket}`;
    }
  } catch (_) {
    // A failed migration should never strand the user on the legacy hostname.
  }
  window.location.replace(url.toString());
}

async function claimBrowserSessionHandoff() {
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  const ticket = hashParams.get(HANDOFF_HASH_KEY);
  if (!ticket || !HANDOFF_TICKET_RE.test(ticket)) return;

  try {
    await fetch('/api/auth/claim-host-handoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ ticket }),
    });
  } finally {
    // Do not keep even a single-use ticket in history, copied URLs or a future
    // referrer. The server consumes it before returning a response.
    hashParams.delete(HANDOFF_HASH_KEY);
    const remainingHash = hashParams.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${remainingHash ? `#${remainingHash}` : ''}`);
  }
}

async function boot() {
  await claimBrowserSessionHandoff();
  createRoot(document.getElementById('root')!).render(<App />);
}

if (window.location.hostname === '127.0.0.1' && !isNativeWidget && !isOAuthCallback) {
  void moveLegacyBrowserSession();
} else {
  void boot();
}
