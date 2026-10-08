// ─── Planner agent: the server half ─────────────────────────────────────────
//
// Owns conversations, talks to Ollama Cloud, runs the tool loop, and writes
// planner data ONLY through the injected `writeStore` (the same safe-write +
// sync-ingest path the app's own saves take, so every change reaches the
// other windows and the phone like any other edit).
//
// A run lives on the server, not in a browser tab: the phone can lock, the PC
// window can close, and the reply still finishes. Clients watch it through
// one SSE stream per user.
//
// The API key never leaves this process. It is read from the repo's `.env`
// (git-ignored) and is sent to nothing but ollama.com.

import fsp from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

import {
  runTool, applyDeletion, applyFocusDeletion, planUndo, verifyAgainst, answersToResult,
  TOOL_DEFS, READ_ONLY_TOOLS,
  type AgentWorld, type ToolOutcome, type UndoRecord, type DeletionPlan, type EventData, type PrayerDay,
} from './src/lib/agent/agentTools';
import { buildSystemPrompt } from './src/lib/agent/agentPrompt';
import type { FocusSessionRecord } from './src/lib/focusStats';
import type { FocusTimerState } from './src/lib/focusTimer';
import {
  AGENT_LIMITS,
  type AgentAttachment, type AgentConversation, type AgentConversationSummary, type AgentMessage,
  type AgentQuestion, type AgentQuestionAnswer, type AgentStreamEvent, type AgentToolTrace, type ChangeSet,
} from './src/lib/agent/agentTypes';
import { coerceCategories } from './src/lib/categories';
import { coerceTaskLists } from './src/lib/taskLists';
import { coerceNotificationSettings } from './src/lib/notifications';
import { coercePrayerSettings, prayerMonthsFromCache } from './src/lib/prayerTimes';
import { coerceTasks, type TaskData } from './src/lib/tasks';
import type { WeekStartsOn } from './src/lib/recurrence';

// ─── Wiring ──────────────────────────────────────────────────────────────────

export interface AgentUserPaths {
  dbDir: string;
  dbPath: string;
  tasksPath: string;
  settingsPath: string;
  backupDir: string;
}

export interface AgentAuth {
  user: { username: string; name?: string };
  userPaths: AgentUserPaths;
}

export interface AgentServiceDeps {
  rootDir: string;
  requireAuth: (req: any, res: any) => Promise<AgentAuth | null>;
  /** Safe write + sync ingest, awaited. Throws when the write was refused. */
  writeStore: (username: string, userPaths: AgentUserPaths, store: 'events' | 'tasks', snapshot: object, baseId?: string) => Promise<void>;
  /** Register a snapshot as a merge baseline; returns its id. */
  noteBase: (username: string, store: 'events' | 'tasks', snapshot: object) => string | undefined;
  isLoopback: (req: any) => boolean;
  log: (line: string) => void;
}

interface Middlewares { use: (route: string, handler: (req: any, res: any, next: () => void) => void) => void }

// ─── Config ──────────────────────────────────────────────────────────────────

interface OllamaConfig { apiKey: string; baseUrl: string; model: string }

function readEnvFile(rootDir: string): Record<string, string> {
  try {
    const raw = fsSync.readFileSync(path.join(rootDir, '.env'), 'utf-8');
    const out: Record<string, string> = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}

/** Re-read on every run, so a new key or model needs no server restart. */
function loadConfig(rootDir: string): OllamaConfig | null {
  const env = { ...readEnvFile(rootDir), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OLLAMA_'))) } as Record<string, string>;
  const apiKey = env.OLLAMA_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl: (env.OLLAMA_BASE_URL?.trim() || 'https://ollama.com').replace(/\/+$/, ''),
    model: env.OLLAMA_AGENT_MODEL?.trim() || 'gemma4:31b',
  };
}

const MAX_STEPS = 24;
const IDLE_TIMEOUT_MS = 120_000;

// ─── The model-side transcript ───────────────────────────────────────────────

interface LlmMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  attachmentIds?: string[];
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
  tool_name?: string;
}

type Pending =
  | { kind: 'question'; messageId: string; questions: AgentQuestion[]; after: LlmMessage[] }
  | { kind: 'approval'; messageId: string; approvalId: string; plan: DeletionPlan; after: LlmMessage[] };

interface LlmState { messages: LlmMessage[]; pending?: Pending }

// ─── Small utilities ─────────────────────────────────────────────────────────

const newId = () => crypto.randomUUID();

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fsp.readFile(file, 'utf-8')) as T; } catch { return fallback; }
}

/**
 * Write via a temp file and rename. On Windows the rename fails with EPERM or
 * EBUSY while ANY other handle has the target open (a stream reading the
 * conversation, the antivirus scanning it), so it is retried with a short
 * backoff; writes to the same file are also queued so two saves of one
 * conversation never race each other.
 */
const fileQueues = new Map<string, Promise<unknown>>();
async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const body = JSON.stringify(data);
  const prev = fileQueues.get(file) ?? Promise.resolve();
  const job = prev.catch(() => {}).then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    await fsp.writeFile(tmp, body, 'utf-8');
    for (let attempt = 0; ; attempt++) {
      try {
        await fsp.rename(tmp, file);
        return;
      } catch (err: any) {
        const code = err?.code;
        if ((code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') || attempt >= 12) {
          await fsp.unlink(tmp).catch(() => {});
          throw err;
        }
        await new Promise(r => setTimeout(r, 15 + attempt * 25));
      }
    }
  });
  fileQueues.set(file, job);
  try { await job; } finally { if (fileQueues.get(file) === job) fileQueues.delete(file); }
}

function readBody(req: any, limit: number): Promise<string> {
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

function sendJson(res: any, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(payload));
}

const SAFE_ID = /^[a-zA-Z0-9-]{8,64}$/;

// ─── The service ─────────────────────────────────────────────────────────────

export function registerAgentRoutes(middlewares: Middlewares, deps: AgentServiceDeps) {
  const { rootDir, log } = deps;

  const agentDir = (p: AgentUserPaths) => path.join(p.dbDir, 'agent');
  const convFile = (p: AgentUserPaths, id: string) => path.join(agentDir(p), 'conversations', `${id}.json`);
  const llmFile = (p: AgentUserPaths, id: string) => path.join(agentDir(p), 'conversations', `${id}.llm.json`);
  const undoFile = (p: AgentUserPaths, id: string) => path.join(agentDir(p), 'undo', `${id}.json`);
  const uploadDir = (p: AgentUserPaths) => path.join(agentDir(p), 'uploads');

  // Per-user write lock: tool writes, approvals and undos never interleave.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(username: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(username) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    locks.set(username, next.catch(() => {}));
    return next;
  }

  // Per-conversation run registry, so a second send cannot start a parallel run.
  const running = new Map<string, AbortController>();

  // ── Live stream ──
  interface Sub { res: any; username: string }
  const subs = new Set<Sub>();
  function emit(username: string, ev: AgentStreamEvent) {
    const line = `data: ${JSON.stringify(ev)}\n\n`;
    for (const s of subs) {
      if (s.username !== username) continue;
      try { s.res.write(line); } catch { /* closed; cleaned up on 'close' */ }
    }
  }

  // ── Conversation storage ──
  async function loadConv(p: AgentUserPaths, id: string): Promise<AgentConversation | null> {
    if (!SAFE_ID.test(id)) return null;
    return readJson<AgentConversation | null>(convFile(p, id), null);
  }
  async function saveConv(username: string, p: AgentUserPaths, conv: AgentConversation, broadcast = true) {
    conv.updatedAt = Date.now();
    await writeJsonAtomic(convFile(p, conv.id), conv);
    if (broadcast) {
      emit(username, { type: 'conversation', conversation: conv });
      emit(username, { type: 'list', conversations: await listConvs(p) });
    }
  }
  async function loadLlm(p: AgentUserPaths, id: string): Promise<LlmState> {
    return readJson<LlmState>(llmFile(p, id), { messages: [] });
  }
  async function saveLlm(p: AgentUserPaths, id: string, s: LlmState) {
    await writeJsonAtomic(llmFile(p, id), s);
  }
  async function listConvs(p: AgentUserPaths): Promise<AgentConversationSummary[]> {
    const dir = path.join(agentDir(p), 'conversations');
    let files: string[] = [];
    try { files = await fsp.readdir(dir); } catch { return []; }
    const out: AgentConversationSummary[] = [];
    for (const f of files) {
      if (!f.endsWith('.json') || f.endsWith('.llm.json')) continue;
      const c = await readJson<AgentConversation | null>(path.join(dir, f), null);
      if (!c) continue;
      const lastText = [...c.messages].reverse().find(m => m.text)?.text ?? '';
      out.push({ id: c.id, title: c.title, updatedAt: c.updatedAt, state: c.state, messageCount: c.messages.length, preview: lastText.slice(0, 120) });
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // A run that was mid-flight when the server stopped can never resume by
  // itself; say so instead of spinning forever.
  async function healInterrupted(username: string, p: AgentUserPaths, conv: AgentConversation) {
    if (conv.state !== 'running' || running.has(conv.id)) return conv;
    conv.state = 'error';
    conv.liveText = undefined;
    conv.liveThinking = undefined;
    const last = conv.messages[conv.messages.length - 1];
    if (last?.role === 'assistant') last.error = 'The planner server restarted while this reply was being written. Anything listed as saved above really was saved. Send your message again to continue.';
    await saveConv(username, p, conv);
    return conv;
  }

  // ── The planner snapshot a tool sees ──
  async function loadWorld(auth: AgentAuth): Promise<AgentWorld> {
    const p = auth.userPaths;
    const [events, tasksRaw, settings, gcals, prayerCache, focusRaw, timerRaw] = await Promise.all([
      readJson<EventData>(p.dbPath, {}),
      readJson<unknown>(p.tasksPath, {}),
      readJson<Record<string, any>>(p.settingsPath, {}),
      readJson<{ ownedCalendarId?: string; calendars?: Array<{ id: string; summary: string }> }>(path.join(p.dbDir, 'google-calendars.json'), {}),
      readJson<Record<string, unknown>>(path.join(rootDir, 'database', 'prayer-times.json'), {}),
      readJson<unknown[]>(path.join(p.dbDir, 'focus-sessions.json'), []),
      readJson<unknown>(path.join(p.dbDir, 'focus-timer.json'), null),
    ]);
    const prayerSettings = coercePrayerSettings(settings.prayer);
    const months = prayerMonthsFromCache(prayerCache, prayerSettings);
    const ws = Number(settings.weekStartsOn);
    const dayStartH = Number.isFinite(Number(settings.dayStartH)) ? Number(settings.dayStartH) : 0;
    return {
      now: new Date(),
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
      events: events && typeof events === 'object' && !Array.isArray(events) ? events : {},
      tasks: coerceTasksKeepAll(tasksRaw),
      categories: coerceCategories(settings.categories),
      taskLists: coerceTaskLists(settings.taskLists),
      weekStartsOn: (Number.isInteger(ws) && ws >= 0 && ws <= 6 ? ws : 0) as WeekStartsOn,
      dayStartH,
      dayEndH: Number.isFinite(Number(settings.dayEndH)) ? Number(settings.dayEndH) : 24,
      timeFormat: settings.timeFormat === '24h' ? '24h' : '12h',
      notificationDefaults: coerceNotificationSettings(settings.notifications),
      ownedCalendarId: gcals.ownedCalendarId,
      calendars: Array.isArray(gcals.calendars) ? gcals.calendars : [],
      prayersFor: (date: string) => (months[date.slice(0, 7)]?.[date] as PrayerDay | undefined) ?? null,
      focusSessions: Array.isArray(focusRaw) ? focusRaw.filter(s => s && typeof s === 'object') as FocusSessionRecord[] : [],
      focusTimer: timerRaw && typeof timerRaw === 'object' ? timerRaw as FocusTimerState : null,
      focusDailyGoalSeconds: Number(settings.focusDailyGoalSeconds) || 0,
      focusExcludedDates: Array.isArray(settings.focusExcludedDates) ? settings.focusExcludedDates : [],
      focusDayStartHour: Number.isFinite(Number(settings.focusDayStartHour)) ? Number(settings.focusDayStartHour) : dayStartH,
    };
  }

  /**
   * The tasks file exactly as stored. `coerceTasks` drops records it does not
   * recognise, and a snapshot built from the coerced map would then DELETE
   * those records when written back. So the raw map is kept, and coerce is
   * only used to decide it is a map at all.
   */
  function coerceTasksKeepAll(raw: unknown): TaskData {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    coerceTasks(raw);
    return raw as TaskData;
  }

  // ── Committing a tool's outcome ──
  async function commit(auth: AgentAuth, world: AgentWorld, outcome: ToolOutcome, tool: string): Promise<ChangeSet | null> {
    const { username } = auth.user;
    if (outcome.events) {
      const baseId = deps.noteBase(username, 'events', world.events);
      await deps.writeStore(username, auth.userPaths, 'events', outcome.events, baseId);
    }
    if (outcome.tasks) {
      const baseId = deps.noteBase(username, 'tasks', world.tasks);
      await deps.writeStore(username, auth.userPaths, 'tasks', outcome.tasks, baseId);
    }
    if (!outcome.entries?.length) return null;
    // Read back what is REALLY on disk now (after the sync layer's rebuild) and
    // mark each entry verified only if its record landed exactly as written.
    const after = await loadWorld(auth);
    const ok = verifyAgainst(outcome.undo ?? [], after.events, after.tasks);
    const entries = outcome.entries.map(e => ({
      ...e,
      verified: e.verified || ok.has(`${e.kind === 'event' ? 'events' : 'tasks'}:${e.id}`),
    }));
    const cs: ChangeSet = { id: newId(), at: Date.now(), tool, entries };
    if (outcome.undo?.length) await writeJsonAtomic(undoFile(auth.userPaths, cs.id), outcome.undo);
    const unverified = entries.filter(e => !e.verified).length;
    log(`AGENT ${tool} entries=${entries.length}${unverified ? ` UNVERIFIED=${unverified}` : ''}`);
    return cs;
  }

  // ── Talking to the model ──

  async function materialize(auth: AgentAuth, msgs: LlmMessage[]): Promise<Array<Record<string, unknown>>> {
    // Images are re-sent only for the two most recent user messages that have
    // them. Older ones were already read; resending every screenshot on every
    // step would make each call slower and costlier for nothing.
    const withImages = msgs
      .map((m, i) => (m.role === 'user' && m.attachmentIds?.length ? i : -1))
      .filter(i => i >= 0)
      .slice(-2);
    const out: Array<Record<string, unknown>> = [];
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const o: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) o.tool_calls = m.tool_calls;
      if (m.tool_name) o.tool_name = m.tool_name;
      if (m.attachmentIds?.length) {
        if (withImages.includes(i)) {
          const images: string[] = [];
          for (const id of m.attachmentIds) {
            const meta = await readJson<AgentAttachment | null>(path.join(uploadDir(auth.userPaths), `${id}.json`), null);
            if (meta?.kind !== 'image') continue;
            try { images.push((await fsp.readFile(path.join(uploadDir(auth.userPaths), `${id}.bin`))).toString('base64')); } catch { /* gone */ }
          }
          if (images.length) o.images = images;
        } else {
          o.content = `${m.content}\n\n[${m.attachmentIds.length} attachment(s) were sent with this message and already read earlier.]`;
        }
      }
      out.push(o);
    }
    return out;
  }

  interface ModelTurn { content: string; thinking: string; toolCalls: Array<{ function: { name: string; arguments: unknown } }> }

  async function callModel(
    cfg: OllamaConfig,
    messages: Array<Record<string, unknown>>,
    signal: AbortSignal,
    onDelta: (d: { text?: string; thinking?: string }) => void,
  ): Promise<ModelTurn> {
    let attempt = 0;
    for (;;) {
      attempt++;
      let streamed = false;
      try {
        const res = await fetch(`${cfg.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: cfg.model, messages, tools: TOOL_DEFS, stream: true, think: true, options: { temperature: 0.2 } }),
          signal,
        });
        if (res.status === 401 || res.status === 403) throw new FatalModelError('Ollama rejected the API key. Put a valid key in the .env file (OLLAMA_API_KEY).');
        if (res.status === 404) throw new FatalModelError(`Ollama does not know the model "${cfg.model}".`);
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => '');
          throw new RetryableModelError(`Ollama answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, res.status === 429 || res.status >= 500);
        }
        const turn: ModelTurn = { content: '', thinking: '', toolCalls: [] };
        const decoder = new TextDecoder();
        let buf = '';
        const reader = (res.body as any).getReader();
        let idle: NodeJS.Timeout | null = null;
        const armIdle = () => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => reader.cancel().catch(() => {}), IDLE_TIMEOUT_MS);
        };
        armIdle();
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            armIdle();
            buf += decoder.decode(value, { stream: true });
            let nl: number;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim();
              buf = buf.slice(nl + 1);
              if (!line) continue;
              let j: any;
              try { j = JSON.parse(line); } catch { continue; }
              if (j.error) throw new RetryableModelError(String(j.error), !streamed);
              const msg = j.message ?? {};
              if (msg.thinking) { turn.thinking += msg.thinking; streamed = true; onDelta({ thinking: msg.thinking }); }
              if (msg.content) { turn.content += msg.content; streamed = true; onDelta({ text: msg.content }); }
              if (Array.isArray(msg.tool_calls)) { turn.toolCalls.push(...msg.tool_calls); streamed = true; }
            }
          }
        } finally {
          if (idle) clearTimeout(idle);
        }
        return turn;
      } catch (err: any) {
        if (signal.aborted) throw new StoppedError();
        if (err instanceof FatalModelError) throw err;
        const retryable = err instanceof RetryableModelError ? err.retryable : !streamed;
        if (!retryable || attempt >= 4) {
          throw new FatalModelError(err instanceof RetryableModelError ? err.message : `Could not reach Ollama Cloud (${err?.message ?? err}).`);
        }
        await new Promise(r => setTimeout(r, [0, 1500, 4000, 9000][attempt] ?? 9000));
      }
    }
  }

  // ── The loop ──

  async function runLoop(auth: AgentAuth, convId: string) {
    const { username } = auth.user;
    const p = auth.userPaths;
    const cfg = loadConfig(rootDir);
    const controller = new AbortController();
    running.set(convId, controller);

    const conv = (await loadConv(p, convId))!;
    const llm = await loadLlm(p, convId);
    const msg: AgentMessage = { id: newId(), role: 'assistant', at: Date.now(), text: '', tools: [], changeSetIds: [] };
    conv.messages.push(msg);
    conv.state = 'running';
    conv.liveText = '';
    conv.liveThinking = '';
    await saveConv(username, p, conv);

    // Deltas are coalesced so a fast stream does not become 200 tiny writes.
    let pendingText = '';
    let pendingThinking = '';
    let flushTimer: NodeJS.Timeout | null = null;
    const flush = () => {
      flushTimer = null;
      if (!pendingText && !pendingThinking) return;
      emit(username, { type: 'delta', conversationId: convId, text: pendingText || undefined, thinking: pendingThinking || undefined });
      pendingText = '';
      pendingThinking = '';
    };
    const onDelta = (d: { text?: string; thinking?: string }) => {
      if (d.text) { pendingText += d.text; conv.liveText = (conv.liveText ?? '') + d.text; }
      if (d.thinking) { pendingThinking += d.thinking; conv.liveThinking = (conv.liveThinking ?? '') + d.thinking; }
      if (!flushTimer) flushTimer = setTimeout(flush, 70);
    };

    const finish = async (state: AgentConversation['state'], error?: string) => {
      if (flushTimer) { clearTimeout(flushTimer); flush(); }
      conv.state = state;
      conv.liveText = undefined;
      conv.liveThinking = undefined;
      if (error) msg.error = error;
      await saveLlm(p, convId, llm);
      await saveConv(username, p, conv);
    };

    try {
      if (!cfg) {
        await finish('error', 'The assistant is not set up: OLLAMA_API_KEY is missing from the .env file on the PC.');
        return;
      }
      conv.model = cfg.model;

      for (let step = 0; step < MAX_STEPS; step++) {
        const world = await loadWorld(auth);
        const system = buildSystemPrompt(world, auth.user.name || auth.user.username);
        const messages = [{ role: 'system', content: system }, ...(await materialize(auth, llm.messages))];
        const turn = await callModel(cfg, messages, controller.signal, onDelta);
        if (flushTimer) { clearTimeout(flushTimer); flush(); }

        llm.messages.push({
          role: 'assistant',
          content: turn.content,
          ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map(c => ({ function: { name: c.function.name, arguments: c.function.arguments } })) } : {}),
        });
        if (turn.content.trim()) msg.text = msg.text ? `${msg.text}\n\n${turn.content.trim()}` : turn.content.trim();
        if (turn.thinking.trim()) msg.thinking = msg.thinking ? `${msg.thinking}\n\n${turn.thinking.trim()}` : turn.thinking.trim();
        conv.liveText = '';
        conv.liveThinking = '';

        if (!turn.toolCalls.length) {
          await finish('idle');
          return;
        }

        let paused: Pending | null = null;
        for (const call of turn.toolCalls) {
          const name = String(call.function?.name ?? '');
          const args = call.function?.arguments;
          if (paused) {
            paused.after.push({ role: 'tool', tool_name: name, content: JSON.stringify({ notRun: 'The conversation paused for the user first. Call this again after their answer if it is still needed.' }) });
            continue;
          }
          const trace: AgentToolTrace = { id: newId(), name, label: toolRunningLabel(name), status: 'running', startedAt: Date.now() };
          msg.tools!.push(trace);
          await saveConv(username, p, conv);

          let outcome: ToolOutcome;
          let cs: ChangeSet | null = null;
          try {
            if (READ_ONLY_TOOLS.has(name) || name === 'ask_user' || name === 'delete_items') {
              outcome = runTool(name, args, await loadWorld(auth));
            } else {
              ({ outcome, cs } = await withLock(username, async () => {
                const fresh = await loadWorld(auth);
                const o = runTool(name, args, fresh);
                const c = (o.events || o.tasks || o.entries?.length) && !o.isError ? await commit(auth, fresh, o, name) : null;
                return { outcome: o, cs: c };
              }));
            }
          } catch (err: any) {
            log(`AGENT tool ${name} crashed: ${err?.stack ?? err}`);
            outcome = { isError: true, label: `${name} failed`, result: { error: `The tool failed inside the app: ${err?.message ?? err}. Nothing was changed by this call.` } };
          }

          trace.status = outcome.isError ? (name && !TOOL_DEFS.some(t => t.function.name === name) ? 'rejected' : 'error') : 'ok';
          trace.label = outcome.label;
          trace.endedAt = Date.now();
          if (outcome.isError) trace.error = (outcome.result as { error?: string })?.error;
          if (cs) {
            conv.changeSets[cs.id] = cs;
            msg.changeSetIds!.push(cs.id);
          }

          if (outcome.pause?.kind === 'question') {
            msg.questions = outcome.pause.questions;
            paused = { kind: 'question', messageId: msg.id, questions: outcome.pause.questions, after: [] };
          } else if (outcome.pause?.kind === 'approval') {
            msg.approval = outcome.pause.approval;
            paused = { kind: 'approval', messageId: msg.id, approvalId: outcome.pause.approval.id, plan: outcome.pause.plan, after: [] };
          } else {
            llm.messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(outcome.result) });
          }
          await saveConv(username, p, conv);
        }

        if (paused) {
          llm.pending = paused;
          await finish(paused.kind === 'question' ? 'awaiting_answer' : 'awaiting_approval');
          return;
        }
      }
      await finish('idle', `Stopped after ${MAX_STEPS} steps to be safe. Everything listed above was saved. Tell me to continue if there is more to do.`);
    } catch (err: any) {
      if (err instanceof StoppedError) {
        // Keep the transcript consistent: a stopped turn has no pending calls.
        await finish('idle', 'Stopped. Anything listed above was already saved.');
      } else {
        log(`AGENT run failed: ${err?.stack ?? err}`);
        await finish('error', err instanceof FatalModelError ? err.message : `Something went wrong: ${err?.message ?? err}`);
      }
    } finally {
      running.delete(convId);
    }
  }

  function toolRunningLabel(name: string): string {
    switch (name) {
      case 'list_items': return 'Checking your calendar';
      case 'search_items': return 'Searching';
      case 'find_free_time': return 'Looking for free time';
      case 'create_events': return 'Adding events';
      case 'update_events': return 'Updating events';
      case 'create_tasks': return 'Adding tasks';
      case 'update_tasks': return 'Updating tasks';
      case 'delete_items': return 'Preparing a deletion for your approval';
      case 'list_focus_sessions': return 'Checking your focus sessions';
      case 'get_focus_stats': return 'Looking at your focus stats';
      case 'delete_focus_sessions': return 'Preparing to delete focus sessions';
      case 'ask_user': return 'Asking you';
      default: return `Unknown tool "${name}"`;
    }
  }

  // ── Starting and resuming ──

  function startLoop(auth: AgentAuth, convId: string) {
    runLoop(auth, convId).catch(err => log(`AGENT loop crashed: ${err?.stack ?? err}`));
  }

  /** A user message that arrives while the agent waits: it answers or declines. */
  function resolvePendingByText(llm: LlmState, conv: AgentConversation, text: string) {
    const pending = llm.pending;
    if (!pending) return;
    const m = conv.messages.find(x => x.id === pending.messageId);
    if (pending.kind === 'question') {
      llm.messages.push({ role: 'tool', tool_name: 'ask_user', content: JSON.stringify({ answers: 'The user did not pick an option and wrote a reply instead (see their next message).' }) });
      if (m) m.answers = pending.questions.map(q => ({ questionId: q.id, selected: [], other: '(answered in a message)' }));
    } else {
      llm.messages.push({ role: 'tool', tool_name: 'delete_items', content: JSON.stringify({ approved: false, deleted: 0, note: 'The user wrote a message instead of approving. Nothing was deleted. Read their message.' }) });
      if (m) m.approvalDecision = { approved: false, at: Date.now(), note: 'Replied instead of approving' };
    }
    llm.messages.push(...pending.after);
    llm.pending = undefined;
    void text;
  }

  // ─── Routes ────────────────────────────────────────────────────────────────

  middlewares.use('/api/agent', async (req, res, next) => {
    const url = new URL(req.url || '/', 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    const method = req.method || 'GET';

    const auth = await deps.requireAuth(req, res);
    if (!auth) return;
    const { username } = auth.user;
    const p = auth.userPaths;

    try {
      // GET /api/agent/status
      if (parts[0] === 'status' && method === 'GET') {
        const cfg = loadConfig(rootDir);
        return sendJson(res, 200, { configured: !!cfg, model: cfg?.model ?? null, limits: AGENT_LIMITS, dictation: deps.isLoopback(req) });
      }

      // GET /api/agent/stream  (SSE)
      if (parts[0] === 'stream' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        const sub: Sub = { res, username };
        subs.add(sub);
        res.write(`data: ${JSON.stringify({ type: 'list', conversations: await listConvs(p) } satisfies AgentStreamEvent)}\n\n`);
        const want = url.searchParams.get('conversation');
        if (want) {
          const c = await loadConv(p, want);
          if (c) res.write(`data: ${JSON.stringify({ type: 'conversation', conversation: await healInterrupted(username, p, c) } satisfies AgentStreamEvent)}\n\n`);
        }
        const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 20_000);
        const close = () => { clearInterval(ping); subs.delete(sub); };
        req.on('close', close);
        res.on('close', close);
        return;
      }

      // Uploads
      if (parts[0] === 'uploads') {
        if (method === 'POST' && parts.length === 1) {
          const body = JSON.parse(await readBody(req, Math.ceil(AGENT_LIMITS.maxImageBytes * 1.4) + 4096));
          const name = String(body.name || 'file').slice(0, 120);
          const mime = String(body.mime || '').toLowerCase();
          const data = Buffer.from(String(body.data || ''), 'base64');
          const isImage = /^image\/(png|jpe?g|webp|gif|bmp)$/.test(mime);
          const isText = /^text\/|^application\/(json|xml|csv)$/.test(mime) || /\.(txt|md|csv|json|ics|xml|log)$/i.test(name);
          if (!isImage && !isText) return sendJson(res, 415, { error: `This file type (${mime || 'unknown'}) is not supported. Send images or text files.` });
          if (!data.length) return sendJson(res, 400, { error: 'The file is empty.' });
          if (isImage && data.length > AGENT_LIMITS.maxImageBytes) return sendJson(res, 413, { error: 'That image is too large (over 12 MB).' });
          if (isText && data.length > AGENT_LIMITS.maxTextBytes) return sendJson(res, 413, { error: 'That text file is too large (over 400 KB).' });
          const att: AgentAttachment = {
            id: newId(), kind: isImage ? 'image' : 'text', name, mime: mime || 'text/plain', size: data.length,
            ...(Number.isFinite(body.width) ? { width: Math.round(body.width) } : {}),
            ...(Number.isFinite(body.height) ? { height: Math.round(body.height) } : {}),
          };
          await fsp.mkdir(uploadDir(p), { recursive: true });
          await fsp.writeFile(path.join(uploadDir(p), `${att.id}.bin`), data);
          await writeJsonAtomic(path.join(uploadDir(p), `${att.id}.json`), att);
          return sendJson(res, 200, att);
        }
        if (method === 'GET' && parts.length === 2 && SAFE_ID.test(parts[1])) {
          const meta = await readJson<AgentAttachment | null>(path.join(uploadDir(p), `${parts[1]}.json`), null);
          if (!meta) return sendJson(res, 404, { error: 'Not found' });
          const buf = await fsp.readFile(path.join(uploadDir(p), `${parts[1]}.bin`));
          res.statusCode = 200;
          res.setHeader('Content-Type', meta.kind === 'image' ? meta.mime : 'text/plain; charset=utf-8');
          res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
          res.end(buf);
          return;
        }
      }

      // Conversations
      if (parts[0] === 'conversations') {
        if (parts.length === 1 && method === 'GET') return sendJson(res, 200, { conversations: await listConvs(p) });
        if (parts.length === 1 && method === 'POST') {
          const cfg = loadConfig(rootDir);
          const conv: AgentConversation = {
            id: newId(), title: 'New chat', createdAt: Date.now(), updatedAt: Date.now(),
            messages: [], changeSets: {}, state: 'idle', model: cfg?.model ?? 'gemma4:31b',
          };
          await saveConv(username, p, conv);
          await saveLlm(p, conv.id, { messages: [] });
          return sendJson(res, 200, conv);
        }

        const id = parts[1];
        const conv = id ? await loadConv(p, id) : null;
        if (!conv) return sendJson(res, 404, { error: 'That conversation does not exist.' });

        if (parts.length === 2 && method === 'GET') return sendJson(res, 200, await healInterrupted(username, p, conv));
        if (parts.length === 2 && method === 'DELETE') {
          running.get(id)?.abort();
          await fsp.rm(convFile(p, id), { force: true });
          await fsp.rm(llmFile(p, id), { force: true });
          emit(username, { type: 'list', conversations: await listConvs(p) });
          return sendJson(res, 200, { ok: true });
        }

        const action = parts[2];
        if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
        const body = JSON.parse((await readBody(req, 256 * 1024)) || '{}');

        if (action === 'stop') {
          running.get(id)?.abort();
          return sendJson(res, 200, { ok: true });
        }

        if (running.has(id)) return sendJson(res, 409, { error: 'The assistant is still working on this chat. Wait for it, or press Stop.' });

        if (action === 'messages') {
          const text = typeof body.text === 'string' ? body.text.slice(0, AGENT_LIMITS.maxMessageChars) : '';
          const ids: string[] = Array.isArray(body.attachmentIds) ? body.attachmentIds.filter((x: unknown) => typeof x === 'string' && SAFE_ID.test(x)).slice(0, AGENT_LIMITS.maxAttachments) : [];
          if (!text.trim() && !ids.length) return sendJson(res, 400, { error: 'Write something or attach a file.' });
          const atts: AgentAttachment[] = [];
          for (const aid of ids) {
            const meta = await readJson<AgentAttachment | null>(path.join(uploadDir(p), `${aid}.json`), null);
            if (meta) atts.push(meta);
          }
          const llm = await loadLlm(p, id);
          resolvePendingByText(llm, conv, text);
          // Text files travel inline; images travel as images.
          let content = text.trim() || '(See the attached image.)';
          for (const a of atts.filter(x => x.kind === 'text')) {
            const raw = await fsp.readFile(path.join(uploadDir(p), `${a.id}.bin`), 'utf-8').catch(() => '');
            content += `\n\n--- Attached file "${a.name}" ---\n${raw}\n--- End of "${a.name}" ---`;
          }
          const imageIds = atts.filter(x => x.kind === 'image').map(x => x.id);
          llm.messages.push({ role: 'user', content, ...(imageIds.length ? { attachmentIds: imageIds } : {}) });
          conv.messages.push({ id: newId(), role: 'user', at: Date.now(), text: text.trim(), ...(atts.length ? { attachments: atts } : {}) });
          if (conv.title === 'New chat') conv.title = makeTitle(text, atts);
          await saveLlm(p, id, llm);
          await saveConv(username, p, conv);
          startLoop(auth, id);
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'answer') {
          const llm = await loadLlm(p, id);
          const pending = llm.pending;
          if (!pending || pending.kind !== 'question' || conv.state !== 'awaiting_answer') return sendJson(res, 409, { error: 'There is no open question.' });
          const answers: AgentQuestionAnswer[] = (Array.isArray(body.answers) ? body.answers : []).map((a: any) => ({
            questionId: String(a?.questionId ?? ''),
            selected: Array.isArray(a?.selected) ? a.selected.map(String).slice(0, 8) : [],
            ...(typeof a?.other === 'string' && a.other.trim() ? { other: a.other.trim().slice(0, 2000) } : {}),
          })).filter((a: AgentQuestionAnswer) => pending.questions.some(q => q.id === a.questionId));
          const m = conv.messages.find(x => x.id === pending.messageId);
          if (m) m.answers = answers;
          llm.messages.push({ role: 'tool', tool_name: 'ask_user', content: JSON.stringify(answersToResult(pending.questions, answers)) });
          llm.messages.push(...pending.after);
          llm.pending = undefined;
          await saveLlm(p, id, llm);
          conv.state = 'idle';
          await saveConv(username, p, conv);
          startLoop(auth, id);
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'approval') {
          const llm = await loadLlm(p, id);
          const pending = llm.pending;
          if (!pending || pending.kind !== 'approval' || conv.state !== 'awaiting_approval') return sendJson(res, 409, { error: 'There is nothing waiting for approval.' });
          const approved = body.approved === true;
          const m = conv.messages.find(x => x.id === pending.messageId);
          let result: unknown;
          const isFocusDeletion = !!(pending.plan.focusSessionIds?.length);
          const toolName = isFocusDeletion ? 'delete_focus_sessions' : 'delete_items';
          if (approved) {
            const { outcome, cs } = await withLock(username, async () => {
              const fresh = await loadWorld(auth);
              let o: ToolOutcome;
              if (isFocusDeletion) {
                // Focus session deletion: write directly to focus-sessions.json
                const focusResult = applyFocusDeletion(pending.plan.focusSessionIds!, fresh.focusSessions, fresh);
                if (focusResult.deleted > 0) {
                  await writeJsonAtomic(path.join(auth.userPaths.dbDir, 'focus-sessions.json'), focusResult.sessions);
                }
                o = {
                  entries: focusResult.entries,
                  result: { approved: true, deleted: focusResult.deleted, items: pending.plan.focusSessionIds },
                  label: `Deleted ${focusResult.deleted} focus session${focusResult.deleted === 1 ? '' : 's'}`,
                };
              } else {
                o = applyDeletion(pending.plan, fresh);
              }
              const c = await commit(auth, fresh, o, toolName);
              return { outcome: o, cs: c };
            });
            result = outcome.result;
            if (cs && m) {
              conv.changeSets[cs.id] = cs;
              m.changeSetIds = [...(m.changeSetIds ?? []), cs.id];
            }
          } else {
            result = { approved: false, deleted: 0, note: 'The user pressed Deny. Nothing was deleted. Do not ask again unless they bring it up.' };
          }
          if (m) m.approvalDecision = { approved, at: Date.now() };
          llm.messages.push({ role: 'tool', tool_name: toolName, content: JSON.stringify(result) });
          llm.messages.push(...pending.after);
          llm.pending = undefined;
          await saveLlm(p, id, llm);
          conv.state = 'idle';
          await saveConv(username, p, conv);
          startLoop(auth, id);
          return sendJson(res, 200, { ok: true });
        }

        if (action === 'undo') {
          const csId = String(body.changeSetId ?? '');
          const cs = conv.changeSets[csId];
          if (!cs || !SAFE_ID.test(csId)) return sendJson(res, 404, { error: 'Nothing to undo there.' });
          if (cs.undoneAt) return sendJson(res, 409, { error: 'Already undone.' });
          const records = await readJson<UndoRecord[]>(undoFile(p, csId), []);
          const r = await withLock(username, async () => {
            const world = await loadWorld(auth);
            const u = planUndo(records, world.events, world.tasks);
            if (records.some(x => x.store === 'events')) await deps.writeStore(username, p, 'events', u.events, deps.noteBase(username, 'events', world.events));
            if (records.some(x => x.store === 'tasks')) await deps.writeStore(username, p, 'tasks', u.tasks, deps.noteBase(username, 'tasks', world.tasks));
            return u;
          });
          cs.undoneAt = Date.now();
          if (r.skipped.length) cs.undoNote = `${r.skipped.length} item${r.skipped.length === 1 ? ' was' : 's were'} left as they are, because ${r.skipped.length === 1 ? 'it was' : 'they were'} changed again after the assistant's edit.`;
          // Keep the model's picture of the calendar honest.
          const llm = await loadLlm(p, id);
          llm.messages.push({ role: 'user', content: `[Planner app notice, not typed by the user] The user pressed Undo on the changes made by ${cs.tool}. ${r.restored} change(s) were reverted${r.skipped.length ? `; ${r.skipped.length} were kept because they had been edited again` : ''}. Do not redo them unless asked.` });
          await saveLlm(p, id, llm);
          await saveConv(username, p, conv);
          log(`AGENT undo ${cs.tool} restored=${r.restored} skipped=${r.skipped.length}`);
          return sendJson(res, 200, { ok: true, restored: r.restored, skipped: r.skipped.length });
        }

        if (action === 'rename') {
          const title = typeof body.title === 'string' ? body.title.trim().slice(0, 80) : '';
          if (!title) return sendJson(res, 400, { error: 'A title is needed.' });
          conv.title = title;
          await saveConv(username, p, conv);
          return sendJson(res, 200, { ok: true });
        }
      }

      // POST /api/agent/dictate: Windows voice typing (Win+H) for the PC app,
      // whose WebView has no speech recognition of its own. This machine only.
      if (parts[0] === 'dictate' && method === 'POST') {
        if (!deps.isLoopback(req)) return sendJson(res, 403, { error: 'Only on the PC itself.' });
        await pressWinH();
        return sendJson(res, 200, { ok: true });
      }

      return next();
    } catch (err: any) {
      log(`AGENT route error ${method} ${url.pathname}: ${err?.stack ?? err}`);
      if (!res.headersSent) sendJson(res, err?.message === 'too large' ? 413 : 500, { error: err?.message === 'too large' ? 'That is too large.' : 'The assistant hit an error on the PC.' });
    }
  });

  // Nothing survives a restart mid-run; mark such chats so they do not spin.
  log('AGENT routes ready');
}

function makeTitle(text: string, atts: AgentAttachment[]): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t) return t.length > 60 ? `${t.slice(0, 57).trimEnd()}...` : t;
  return atts.some(a => a.kind === 'image') ? 'Image request' : 'File request';
}

class FatalModelError extends Error {}
class RetryableModelError extends Error {
  constructor(message: string, public retryable: boolean) { super(message); }
}
class StoppedError extends Error {}

/**
 * Press Win+H to open Windows voice typing in the focused text box. Uses
 * user32 keybd_event through PowerShell, spawned hidden: no window flashes.
 */
async function pressWinH(): Promise<void> {
  if (process.platform !== 'win32') return;
  const { spawn } = await import('child_process');
  const script = [
    'Add-Type -Namespace W -Name K -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, System.UIntPtr e);\';',
    '[W.K]::keybd_event(0x5B,0,0,[UIntPtr]::Zero);',
    '[W.K]::keybd_event(0x48,0,0,[UIntPtr]::Zero);',
    '[W.K]::keybd_event(0x48,0,2,[UIntPtr]::Zero);',
    '[W.K]::keybd_event(0x5B,0,2,[UIntPtr]::Zero);',
  ].join(' ');
  await new Promise<void>((resolve) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], { windowsHide: true, stdio: 'ignore' });
    child.on('exit', () => resolve());
    child.on('error', () => resolve());
    setTimeout(resolve, 4000);
  });
}
