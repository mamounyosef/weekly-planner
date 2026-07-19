import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

import runtimeErrorOverlay from '@replit/vite-plugin-runtime-error-modal';

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
                await fs.writeFile(dbPath, body, 'utf-8');
                res.setHeader('Content-Type', 'application/json');
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
                await fs.writeFile(settingsPath, body, 'utf-8');
                res.setHeader('Content-Type', 'application/json');
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
                await fs.writeFile(focusPath, body, 'utf-8');
                res.setHeader('Content-Type', 'application/json');
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
