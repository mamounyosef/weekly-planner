// Run the assistant's model speed test from the command line, the same code
// path as the "Test speed" button (POST /api/agent/speed), without a browser.
// Read-only against the planner; the result is saved where the app reads it,
// so the seconds show up in voice mode's model menu straight away.
//
//   npx tsx scripts/agent-speed-test.ts [username]     (default: mamoun)

import path from 'path';
import { fileURLToPath } from 'url';

import { registerAgentRoutes, type AgentUserPaths } from '../agent-service';

const here = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(here, '..', '..', '..');
const username = process.argv[2] || 'mamoun';
const dbDir = path.join(rootDir, 'database', 'users', username);
const userPaths: AgentUserPaths = {
  dbDir,
  dbPath: path.join(dbDir, 'database.json'),
  tasksPath: path.join(dbDir, 'tasks.json'),
  settingsPath: path.join(dbDir, 'settings.json'),
  backupDir: path.join(dbDir, 'backups'),
};

const refuse = async () => { throw new Error('The speed test never writes.'); };
let handler: ((req: any, res: any, next: () => void) => void) | null = null;
registerAgentRoutes({ use: (_route, h) => { handler = h; } }, {
  rootDir,
  requireAuth: async () => ({ user: { username, name: username }, userPaths }),
  writeStore: refuse, noteBase: () => undefined, writeSettings: refuse, togglePrayerDone: refuse,
  writeFocusTimer: refuse, writeFocusSessions: refuse,
  isLoopback: () => true,
  log: line => console.log(line),
});

const req: any = { url: '/speed', method: 'POST', on: (ev: string, fn: (b?: Buffer) => void) => { if (ev === 'data') fn(Buffer.from('{}')); if (ev === 'end') fn(); } };
const res: any = {
  statusCode: 200, headersSent: false, setHeader() {},
  end(body: string) {
    const j = JSON.parse(body);
    if (j.error) { console.error('Failed:', j.error); process.exit(1); }
    const s = (ms: number | null | undefined) => (ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`);
    for (const mode of ['quick', 'thinking'] as const) {
      const rows = Object.entries(j[mode] ?? {}) as Array<[string, any]>;
      rows.sort((a, b) => (a[1].firstWordMs ?? 1e9) - (b[1].firstWordMs ?? 1e9));
      console.log(`\n${mode === 'quick' ? 'WITHOUT thinking' : 'WITH thinking'}\nmodel                 first word   whole reply   looked`);
      for (const [id, r] of rows) {
        console.log(`${id.padEnd(22)}${s(r.firstWordMs).padStart(10)}${s(r.replyMs).padStart(14)}${(r.usedTools ? 'yes' : 'NO').padStart(9)}${r.error ? `  ${r.error}` : ''}`);
      }
    }
    process.exit(0);
  },
};
handler!(req, res, () => { console.error('route not found'); process.exit(1); });
