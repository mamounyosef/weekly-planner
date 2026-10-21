// ─── Voice mode: the server half ─────────────────────────────────────────────
//
// The speech itself (hearing with Whisper, speaking with Kokoro) runs in
// speech-server.py, a Python process on this PC's GPU. This file starts it,
// keeps it alive, and is the only door to it: browsers never reach its port.
//
//   GET  /api/voice/status    is voice mode available, is the engine up
//   GET  /api/voice/voices    the voices to pick from
//   POST /api/voice/preview   one sentence in a voice (WAV), for Settings
//   POST /api/voice/warm      load the models now (the voice view opened)
//   GET  /api/voice/prefs     this user's voice settings (all their devices)
//   PUT  /api/voice/prefs     change some of them
//   WS   /api/voice/ws        one live voice session, piped straight through
//
// The WebSocket is checked against the planner's own sign-in, then the raw
// socket is joined to the engine's: no frame is parsed or copied here.
//
// Voice settings belong to the USER, not the device: the PC and the phone read
// and write one file, database/users/<u>/voice-prefs.json. The engine is told
// the user's saved voice and speed when a session opens (/ws?user=&voice=&speed=)
// and again whenever they change (/session-prefs), and it then ignores the
// page's own values, so every device always speaks in the saved voice.
//
// Spawned with windowsHide and NOT detached, so no console window ever shows
// and the engine goes away with the dev server.

import fsSync from 'fs';
import path from 'path';
import net from 'net';
import { spawn, type ChildProcess } from 'child_process';

import { coerceVoicePrefs, type VoicePrefs } from './src/lib/voice/voiceTypes';

export interface VoiceServiceDeps {
  rootDir: string;
  /** The signed-in check, for plain requests (answers 401 itself). */
  requireAuth: (req: any, res: any) => Promise<{ user: { username: string }; userPaths: { settingsPath: string; dbDir: string } } | null>;
  /** The same check for a WebSocket upgrade, which has no response object. */
  userFor: (req: any) => Promise<{ username: string; dbDir: string } | null>;
  log: (line: string) => void;
}

interface Middlewares { use: (route: string, handler: (req: any, res: any, next: () => void) => void) => void }
interface UpgradeServer { on: (ev: 'upgrade', fn: (req: any, socket: net.Socket, head: Buffer) => void) => void }

const PORT = Number(process.env.PLANNER_SPEECH_PORT) || 5179;
const HOST = '127.0.0.1';
const BOOT_TIMEOUT_MS = 30_000;
const LOG_MAX_BYTES = 2 * 1024 * 1024;

export function registerVoiceRoutes(middlewares: Middlewares, httpServer: UpgradeServer | null, deps: VoiceServiceDeps) {
  const { rootDir, log } = deps;
  const python = path.join(rootDir, '.venv-speech', 'Scripts', process.platform === 'win32' ? 'python.exe' : 'python');
  const script = path.join(rootDir, 'speech-server.py');
  const logFile = path.join(rootDir, 'database', 'speech-server.log');

  let child: ChildProcess | null = null;
  let booting: Promise<boolean> | null = null;

  const available = () => fsSync.existsSync(python) && fsSync.existsSync(script)
    && fsSync.existsSync(path.join(rootDir, 'speech-models', 'kokoro-v1.0.onnx'));

  async function health(timeoutMs = 1500): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) });
      return res.ok ? await res.json() as Record<string, unknown> : null;
    } catch { return null; }
  }

  function appendLog(chunk: Buffer | string) {
    try {
      const st = fsSync.statSync(logFile, { throwIfNoEntry: false } as any) as fsSync.Stats | undefined;
      if (st && st.size > LOG_MAX_BYTES) fsSync.renameSync(logFile, `${logFile}.old`);
      fsSync.appendFileSync(logFile, chunk);
    } catch { /* logging must never break voice mode */ }
  }

  /** The engine is answering on its port, starting it if need be. */
  function ensureEngine(): Promise<boolean> {
    if (booting) return booting;
    booting = (async () => {
      if (await health()) return true;
      if (!available()) return false;
      if (!child || child.exitCode !== null) {
        log('VOICE starting the speech engine');
        appendLog(`\n=== ${new Date().toISOString()} starting ===\n`);
        const c = spawn(python, ['-u', script, '--port', String(PORT)], {
          cwd: rootDir,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        c.stdout?.on('data', appendLog);
        c.stderr?.on('data', appendLog);
        c.on('exit', code => {
          log(`VOICE speech engine exited (${code})`);
          if (child === c) child = null;
        });
        c.on('error', err => log(`VOICE could not start the speech engine: ${err.message}`));
        child = c;
      }
      const until = Date.now() + BOOT_TIMEOUT_MS;
      while (Date.now() < until) {
        if (await health(800)) return true;
        if (!child) return false;
        await new Promise(r => setTimeout(r, 300));
      }
      return false;
    })().finally(() => { booting = null; });
    return booting;
  }

  // ── The user's voice settings ──
  const prefsFile = (dbDir: string) => path.join(dbDir, 'voice-prefs.json');

  /** Saved settings, or null when this user never saved any. */
  function readPrefs(dbDir: string): { prefs: VoicePrefs; updatedAt: number } | null {
    try {
      const raw = JSON.parse(fsSync.readFileSync(prefsFile(dbDir), 'utf-8'));
      return { prefs: coerceVoicePrefs(raw?.prefs), updatedAt: Number(raw?.updatedAt) || 0 };
    } catch { return null; }
  }

  function writePrefs(dbDir: string, prefs: VoicePrefs): { prefs: VoicePrefs; updatedAt: number } {
    const rec = { prefs, updatedAt: Date.now() };
    const file = prefsFile(dbDir);
    const tmp = `${file}.${process.pid}.tmp`;
    fsSync.mkdirSync(dbDir, { recursive: true });
    fsSync.writeFileSync(tmp, JSON.stringify(rec, null, 2));
    fsSync.renameSync(tmp, file);
    return rec;
  }

  /** Open sessions of this user switch voice from their next sentence. */
  async function pushToEngine(username: string, prefs: VoicePrefs) {
    if (!(await health(800))) return;
    try {
      await fetch(`http://${HOST}:${PORT}/session-prefs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: username, voice: prefs.voice, speed: prefs.speed }),
        signal: AbortSignal.timeout(2000),
      });
    } catch { /* an older engine: the new voice applies from the next session */ }
  }

  const stopEngine = () => { try { child?.kill(); } catch { /* gone */ } };
  process.once('exit', stopEngine);

  function sendJson(res: any, status: number, body: unknown) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(body));
  }

  function readBody(req: any, limit = 64 * 1024): Promise<string> {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      req.on('error', reject);
    });
  }

  middlewares.use('/api/voice', async (req, res, next) => {
    const url = new URL(req.url || '/', 'http://x');
    const route = url.pathname.replace(/^\/+|\/+$/g, '');
    const method = req.method || 'GET';
    if (route === 'ws') return next();
    const auth = await deps.requireAuth(req, res);
    if (!auth) return;
    try {
      // The planner's own words, so speech recognition spells them right:
      // category and list names, and the prayers (Whisper turns "Fajr" into
      // "Fadger" without them).
      if (route === 'hints' && method === 'GET') {
        let settings: any = {};
        try { settings = JSON.parse(fsSync.readFileSync(auth.userPaths.settingsPath, 'utf-8')); } catch { /* none yet */ }
        const names = [
          ...(Array.isArray(settings?.categories) ? settings.categories : []),
          ...(Array.isArray(settings?.taskLists) ? settings.taskLists : []),
        ].map((c: any) => (typeof c?.name === 'string' ? c.name.trim() : '')).filter(Boolean);
        const words = [...new Set([...names, 'Fajr', 'Dhuhr', 'Asr', 'Maghrib', 'Isha', 'focus session', 'Daily Planner'])];
        return sendJson(res, 200, { hints: `Words I use: ${words.join(', ')}.`.slice(0, 500) });
      }
      if (route === 'prefs' && method === 'GET') {
        const saved = readPrefs(auth.userPaths.dbDir);
        return sendJson(res, 200, saved ?? { prefs: null, updatedAt: 0 });
      }
      if (route === 'prefs' && (method === 'PUT' || method === 'POST')) {
        let patch: any = {};
        try { patch = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: 'Bad settings.' }); }
        if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return sendJson(res, 400, { error: 'Bad settings.' });
        const base = readPrefs(auth.userPaths.dbDir)?.prefs ?? coerceVoicePrefs({});
        const rec = writePrefs(auth.userPaths.dbDir, coerceVoicePrefs({ ...base, ...patch }));
        log(`VOICE prefs ${auth.user.username} voice=${rec.prefs.voice} speed=${rec.prefs.speed}`);
        if (patch.voice !== undefined || patch.speed !== undefined) void pushToEngine(auth.user.username, rec.prefs);
        return sendJson(res, 200, rec);
      }
      if (route === 'status' && method === 'GET') {
        const h = await health();
        return sendJson(res, 200, {
          available: available(),
          running: !!h,
          ready: !!h?.ready,
          loading: !!h?.loading,
          device: h?.device ?? null,
          error: h?.error ?? null,
        });
      }
      if (!available()) return sendJson(res, 503, { error: 'Voice mode is not installed on this PC (the speech engine is missing).' });
      if (!(await ensureEngine())) return sendJson(res, 503, { error: 'The speech engine did not start. See database/speech-server.log on the PC.' });

      if (route === 'voices' && method === 'GET') {
        const r = await fetch(`http://${HOST}:${PORT}/voices`);
        return sendJson(res, r.status, await r.json());
      }
      if (route === 'warm' && method === 'POST') {
        const r = await fetch(`http://${HOST}:${PORT}/warm`, { method: 'POST' });
        return sendJson(res, r.status, await r.json());
      }
      if (route === 'preview' && method === 'POST') {
        const body = await readBody(req);
        const r = await fetch(`http://${HOST}:${PORT}/preview`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const buf = Buffer.from(await r.arrayBuffer());
        res.statusCode = r.status;
        res.setHeader('Content-Type', r.headers.get('content-type') || 'audio/wav');
        res.setHeader('Cache-Control', 'no-store');
        res.end(buf);
        return;
      }
      return next();
    } catch (err: any) {
      log(`VOICE route error ${method} ${route}: ${err?.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 502, { error: 'The speech engine did not answer.' });
    }
  });

  // ── The live session: authenticate, then join the two sockets ──
  httpServer?.on('upgrade', (req, socket, head) => {
    const pathname = (req.url || '').split('?')[0];
    if (pathname !== '/api/voice/ws') return;
    socket.on('error', () => {});
    const refuse = (status: string) => {
      try { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); } catch { /* gone */ }
    };
    (async () => {
      const user = await deps.userFor(req);
      if (!user) return refuse('401 Unauthorized');
      if (!available()) return refuse('503 Service Unavailable');
      if (!(await ensureEngine())) return refuse('503 Service Unavailable');
      const upstream = net.connect(PORT, HOST);
      upstream.setNoDelay(true);
      socket.setNoDelay(true);
      upstream.on('error', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.on('close', () => socket.destroy());
      upstream.once('connect', () => {
        // Re-send the browser's upgrade request, pointed at the engine's path.
        // The user's saved voice rides along: the engine uses it, not the page's.
        const saved = readPrefs(user.dbDir)?.prefs;
        // (Nothing saved yet: the page's own values, as before.)
        const q = saved ? `?${new URLSearchParams({ user: user.username, voice: saved.voice, speed: String(saved.speed) })}` : '';
        const lines = [`GET /ws${q} HTTP/1.1`, `Host: ${HOST}:${PORT}`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) {
          const k = String(req.rawHeaders[i]);
          if (/^(host|cookie|authorization|origin)$/i.test(k)) continue;
          lines.push(`${k}: ${req.rawHeaders[i + 1]}`);
        }
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });
    })().catch(err => { log(`VOICE upgrade failed: ${err?.message ?? err}`); refuse('500 Internal Server Error'); });
  });

  log(`VOICE routes ready (engine ${available() ? 'installed' : 'NOT installed'})`);
}
