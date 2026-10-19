// ─── Dynamic app config ──────────────────────────────────────────────────────
// Everything static lives in app.json. This file only fills in the planner's
// public address, which is kept out of the (public) repository: it comes from
// PLANNER_PUBLIC_URL, either in the environment or in the repo-root `.env`.
//
// It is REQUIRED for anything that ships: `updates.url` is baked into the APK,
// and an APK built without it can never receive an over-the-air update again.
// So `scripts/build-apk.ps1` and `npm run publish` run strict (a missing value
// stops them). Everything else (Metro, typechecks, a checkout with no `.env`)
// gets a harmless placeholder and a warning, so it still works.

const PLACEHOLDER = 'https://planner.invalid';

const fs = require('node:fs');
const path = require('node:path');

function readPublicUrl() {
  const fromEnv = (process.env.PLANNER_PUBLIC_URL || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const raw = fs.readFileSync(path.resolve(__dirname, '..', '.env'), 'utf-8');
    const m = /^\s*PLANNER_PUBLIC_URL\s*=\s*(.*?)\s*$/m.exec(raw);
    return m ? m[1].replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}

function resolveConfig(config, { strict = process.env.PLANNER_REQUIRE_URL === '1' } = {}) {
  let url = readPublicUrl().replace(/\/+$/, '');
  if (!/^https:\/\/[^/\s]+$/.test(url)) {
    const msg = 'PLANNER_PUBLIC_URL is missing or not a bare https origin. Set it in the repo-root .env '
      + '(e.g. PLANNER_PUBLIC_URL=https://your-host.ts.net). The APK bakes it in as the update URL.';
    if (strict) throw new Error(msg);
    console.warn(`[app.config] ${msg} Using ${PLACEHOLDER} for now.`);
    url = PLACEHOLDER;
  }
  return {
    ...config,
    updates: { ...config.updates, url: `${url}/api/ota/manifest` },
    extra: { ...config.extra, plannerServerUrl: url },
  };
}

module.exports = ({ config }) => resolveConfig(config);
module.exports.resolveConfig = resolveConfig;
