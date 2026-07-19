import path from 'path';
import fsp from 'fs/promises';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

// ─── File-database safety net ──────────────────────────────────────────────
// Guards against a save silently wiping real data (e.g. a stale/empty client
// state getting POSTed, or the server briefly pointing at the wrong path
// mid-refactor): refuses to overwrite non-empty data with an empty payload,
// and keeps a rolling backup of whatever was on disk before every write.
function isEmptyJsonValue(text: string, kind: 'object' | 'array'): boolean {
  try {
    const parsed = JSON.parse(text);
    if (kind === 'array') return Array.isArray(parsed) && parsed.length === 0;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0;
  } catch {
    return true;
  }
}

async function pruneBackups(backupDir: string, baseName: string, keep = 30) {
  try {
    const files = (await fsp.readdir(backupDir)).filter(f => f.startsWith(`${baseName}.`));
    files.sort();
    const excess = files.length - keep;
    for (let i = 0; i < excess; i++) {
      await fsp.unlink(path.join(backupDir, files[i])).catch(() => {});
    }
  } catch {
    // no backups yet
  }
}

async function safeWriteJsonFile(opts: {
  filePath: string;
  backupDir: string;
  baseName: string;
  body: string;
  kind: 'object' | 'array';
  force: boolean;
}): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { filePath, backupDir, baseName, body, kind, force } = opts;

  let existing: string | null = null;
  try {
    existing = await fsp.readFile(filePath, 'utf-8');
  } catch {
    existing = null;
  }

  const existingIsEmpty = existing === null || isEmptyJsonValue(existing, kind);
  const incomingIsEmpty = isEmptyJsonValue(body, kind);

  if (!existingIsEmpty && incomingIsEmpty && !force) {
    return { ok: false, status: 409, error: `Refused to overwrite non-empty ${baseName} with an empty save. Retry with ?force=1 if this is intentional.` };
  }

  if (existing !== null && !existingIsEmpty) {
    try {
      await fsp.mkdir(backupDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      await fsp.writeFile(path.join(backupDir, `${baseName}.${stamp}.json`), existing, 'utf-8');
      await pruneBackups(backupDir, baseName);
    } catch {
      // a failed backup should never block the actual save
    }
  }

  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, body, 'utf-8');
  return { ok: true };
}

const rawPort = process.env.PORT || '5173';
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const basePath = process.env.BASE_PATH || '/';

export default defineConfig({
  base: basePath,
  plugins: [
    react(),
    tailwindcss(),
    runtimeErrorOverlay(),
    {
      name: 'local-file-db-plugin',
      configureServer(server) {
        server.middlewares.use('/api/events', async (req, res, next) => {
          const fs = await import('fs/promises');
          const path = await import('path');
          const dbPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'database.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(dbPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end('{}');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk;
            });
            req.on('end', async () => {
              try {
                const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                const result = await safeWriteJsonFile({ filePath: dbPath, backupDir, baseName: 'database', body, kind: 'object', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write to file database' }));
              }
            });
          } else {
            next();
          }
        });

        server.middlewares.use('/api/settings', async (req, res, next) => {
          const fs = await import('fs/promises');
          const path = await import('path');
          const settingsPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'settings.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(settingsPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end('{}');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk;
            });
            req.on('end', async () => {
              try {
                const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                const result = await safeWriteJsonFile({ filePath: settingsPath, backupDir, baseName: 'settings', body, kind: 'object', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write settings file' }));
              }
            });
          } else {
            next();
          }
        });

        server.middlewares.use('/api/focus-sessions', async (req, res, next) => {
          const fs = await import('fs/promises');
          const path = await import('path');
          const focusPath = path.resolve(import.meta.dirname, '..', '..', 'database', 'focus-sessions.json');
          const backupDir = path.resolve(import.meta.dirname, '..', '..', 'database', 'backups');

          if (req.method === 'GET') {
            try {
              const data = await fs.readFile(focusPath, 'utf-8');
              res.setHeader('Content-Type', 'application/json');
              res.end(data);
            } catch (err) {
              res.setHeader('Content-Type', 'application/json');
              res.end('[]');
            }
          } else if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => {
              body += chunk;
            });
            req.on('end', async () => {
              try {
                const force = new URL(req.url || '', 'http://localhost').searchParams.get('force') === '1';
                const result = await safeWriteJsonFile({ filePath: focusPath, backupDir, baseName: 'focus-sessions', body, kind: 'array', force });
                res.setHeader('Content-Type', 'application/json');
                if (!result.ok) {
                  res.statusCode = result.status;
                  res.end(JSON.stringify({ error: result.error }));
                  return;
                }
                res.end(JSON.stringify({ success: true }));
              } catch (err) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: 'Failed to write focus sessions file' }));
              }
            });
          } else {
            next();
          }
        });

        server.middlewares.use('/api/launch-widget', async (req, res, next) => {
          if (req.method === 'POST') {
            const { spawn } = await import('child_process');
            const path = await import('path');
            const fs = await import('fs/promises');
            const pythonScript = path.resolve(import.meta.dirname, '..', '..', 'widget-window.py');

            const condaExe = 'C:\\ProgramData\\anaconda3\\Scripts\\conda.exe';
            const condaPythonw = 'C:\\ProgramData\\anaconda3\\pythonw.exe';
            let spawnCmd = 'pythonw';
            let spawnArgs = [pythonScript];

            try {
              await fs.access(condaExe);
              spawnCmd = condaExe;
              spawnArgs = ['run', '-n', 'base', 'pythonw', pythonScript];
            } catch (_) {
              try {
                await fs.access(condaPythonw);
                spawnCmd = condaPythonw;
              } catch (__) {
                // fallback to path env
              }
            }

            try {
              const child = spawn(spawnCmd, spawnArgs, {
                detached: true,
                stdio: 'ignore',
                windowsHide: true
              });
              child.unref();
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ success: true }));
            } catch (err) {
              res.statusCode = 500;
              res.end(JSON.stringify({ error: 'Failed to spawn widget wrapper process' }));
            }
          } else {
            next();
          }
        });
      }
    },
    ...(process.env.NODE_ENV !== 'production' &&
    process.env.REPL_ID !== undefined
      ? [
          await import('@replit/vite-plugin-cartographer').then((m) =>
            m.cartographer({
              root: path.resolve(import.meta.dirname, '..'),
            }),
          ),
          await import('@replit/vite-plugin-dev-banner').then((m) =>
            m.devBanner(),
          ),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      '@assets': path.resolve(
        import.meta.dirname,
        '..',
        '..',
        'attached_assets',
      ),
    },
    dedupe: ['react', 'react-dom'],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, 'dist/public'),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: '0.0.0.0',
    allowedHosts: true,
    fs: {
      strict: true,
    },
  },
  preview: {
    port,
    host: '0.0.0.0',
    allowedHosts: true,
  },
});
