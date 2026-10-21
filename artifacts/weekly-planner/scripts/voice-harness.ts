// A test bench for voice mode: the real assistant panel, the real agent and
// voice routes and the real speech engine, on its own port, signed in as one
// user, and READ-ONLY (every write the assistant tries is refused). Lets a
// browser (or an agent driving one) test the whole spoken loop without the
// planner's sign-in or touching any data.
//
//   npx tsx scripts/voice-harness.ts [username] [port]     (mamoun, 5199)
//   then open http://127.0.0.1:5199/
//
// `window.__fakeMic(text)` in that page makes the microphone "say" `text`
// (spoken by the speech engine itself), for testing without a real mic.

import http from 'http';
import path from 'path';
import fsSync from 'fs';
import { fileURLToPath } from 'url';
import { build } from 'vite';
import react from '@vitejs/plugin-react';

import { registerAgentRoutes, type AgentUserPaths } from '../agent-service';
import { registerVoiceRoutes } from '../voice-service';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const rootDir = path.resolve(appDir, '..', '..');
const username = process.argv[2] || 'mamoun';
const port = Number(process.argv[3]) || 5199;
const outDir = path.join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'planner-voice-harness');

const dbDir = path.join(rootDir, 'database', 'users', username);
const userPaths: AgentUserPaths = {
  dbDir,
  dbPath: path.join(dbDir, 'database.json'),
  tasksPath: path.join(dbDir, 'tasks.json'),
  settingsPath: path.join(dbDir, 'settings.json'),
  backupDir: path.join(dbDir, 'backups'),
};

const FAKE_MIC = `
// Replace the microphone with speech from the engine: __fakeMic("text").
(() => {
  let ctx, dest, real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (c) => {
    if (!c || !c.audio) return real(c);
    ctx = ctx || new AudioContext();
    dest = dest || ctx.createMediaStreamDestination();
    const hum = ctx.createConstantSource(); hum.offset.value = 0; hum.connect(dest); hum.start();
    return dest.stream;
  };
  window.__fakeMic = async (text, voice = 'am_michael') => {
    const r = await fetch('/api/voice/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ voice, speed: 1.05, text }) });
    const buf = await ctx.decodeAudioData(await r.arrayBuffer());
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest); src.start();
    return buf.duration;
  };
})();
`;

async function main() {
  console.log('Building the harness page...');
  await build({
    root: path.join(here, 'voice-harness'),
    configFile: false,
    logLevel: 'warn',
    plugins: [react()],
    resolve: { alias: { '@': path.join(appDir, 'src') } },
    build: { outDir, emptyOutDir: true, sourcemap: false },
  });
  const assetsDir = path.join(appDir, 'dist', 'public', 'assets');
  const css = fsSync.readdirSync(assetsDir).find(f => f.endsWith('.css') && f.startsWith('index-'));

  const routes: Array<{ route: string; handler: (req: any, res: any, next: () => void) => void }> = [];
  const middlewares = { use: (route: string, handler: (req: any, res: any, next: () => void) => void) => { routes.push({ route, handler }); } };
  const refuse = async () => { throw new Error('This is the read-only voice harness: nothing is saved.'); };
  const user = { username, name: username };
  const server = http.createServer();

  registerAgentRoutes(middlewares, {
    rootDir,
    requireAuth: async () => ({ user, userPaths }),
    writeStore: refuse, noteBase: () => undefined, writeSettings: refuse, togglePrayerDone: refuse,
    writeFocusTimer: refuse, writeFocusSessions: refuse,
    isLoopback: () => true,
    log: line => console.log(line),
  });
  registerVoiceRoutes(middlewares, server, {
    rootDir,
    requireAuth: async () => ({ userPaths }),
    isSignedIn: async () => true,
    log: line => console.log(line),
  });

  server.on('request', (req, res) => {
    const url = req.url || '/';
    for (const { route, handler } of routes) {
      if (url === route || url.startsWith(`${route}/`) || url.startsWith(`${route}?`)) {
        const original = url;
        req.url = url.slice(route.length) || '/';
        handler(req, res, () => { req.url = original; res.statusCode = 404; res.end('not found'); });
        return;
      }
    }
    if (url === '/app.css' && css) {
      res.setHeader('Content-Type', 'text/css');
      res.end(fsSync.readFileSync(path.join(assetsDir, css)));
      return;
    }
    const file = path.join(outDir, url === '/' ? 'index.html' : url.split('?')[0]);
    if (!file.startsWith(outDir) || !fsSync.existsSync(file) || fsSync.statSync(file).isDirectory()) {
      res.statusCode = 404; res.end('not found'); return;
    }
    const ext = path.extname(file);
    res.setHeader('Content-Type', ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : ext === '.css' ? 'text/css' : 'application/octet-stream');
    let body = fsSync.readFileSync(file);
    if (ext === '.html') body = Buffer.from(body.toString('utf-8').replace('<head>', `<head><script>${FAKE_MIC}</script>`));
    res.end(body);
  });
  server.listen(port, '127.0.0.1', () => console.log(`Voice harness on http://127.0.0.1:${port}/ (user ${username}, read-only)`));
}

main().catch(err => { console.error(err); process.exit(1); });
