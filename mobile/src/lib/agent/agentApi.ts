// ─── Planner agent: the phone's side of the wire ─────────────────────────────
//
// The assistant runs on the PC (it needs the Ollama key, which never leaves
// the PC, and it writes through the PC's sync engine). The phone is a window
// onto it: it posts messages, and watches the conversation over one
// Server-Sent Events stream read with expo/fetch, which can stream response
// bodies on Android. If the stream cannot be opened (a proxy buffering it, a
// flaky network), a slow poll keeps the screen correct, just less lively.
//
// Auth is the same explicit session cookie the sync transport uses: React
// Native has no dependable cookie jar, so the header is attached by hand.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { fetch as streamFetch } from 'expo/fetch';
import * as SecureStore from 'expo-secure-store';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { prefs } from '../prefs';
import { joinUrl, SESSION_COOKIE } from '../syncTransport';
import type {
  AgentAttachment, AgentConversation, AgentConversationSummary, AgentQuestionAnswer, AgentStreamEvent,
} from './agentTypes';
import { AGENT_LIMITS } from './agentTypes';

const ACTIVE_KEY = 'planner.agentActiveConversation';
const MAX_EDGE = 2048;

export class AgentHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function creds(): Promise<{ base: string; headers: Record<string, string> }> {
  const [base, session] = await Promise.all([prefs.getServerUrl(), prefs.getSession()]);
  if (!base) throw new AgentHttpError('Not connected to the planner.', 0);
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (session) headers.Cookie = `${SESSION_COOKIE}=${session}`;
  return { base, headers };
}

export async function agentApi<T>(path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<T> {
  const { base, headers } = await creds();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init?.timeoutMs ?? 30_000);
  let res: Response;
  try {
    res = await fetch(joinUrl(base, path), {
      method: init?.method ?? 'GET',
      headers: { ...headers, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = /abort/i.test(String((err as Error)?.message ?? err));
    throw new AgentHttpError(aborted ? 'The planner did not answer in time.' : 'Could not reach the planner PC.', 0);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* a proxy page, not JSON */ }
  if (res.status === 401 || res.status === 403) throw new AgentHttpError('Signed out. Sign in again in Settings.', res.status);
  if (!res.ok) throw new AgentHttpError((body as { error?: string })?.error || `The planner answered ${res.status}.`, res.status);
  return body as T;
}

// ─── Images ─────────────────────────────────────────────────────────────────

export interface LocalImage {
  /** file:// or data: URI */
  uri: string;
  width?: number;
  height?: number;
  name?: string;
}

/** Shrink to at most 2048 px on the long edge, JPEG, and upload. */
export async function uploadImage(img: LocalImage): Promise<AgentAttachment> {
  let base64: string | undefined;
  let width = img.width;
  let height = img.height;
  try {
    const ctx = ImageManipulator.manipulate(img.uri);
    const long = Math.max(width ?? 0, height ?? 0);
    if (!long || long > MAX_EDGE) {
      // Unknown size: resizing by width alone keeps the aspect ratio.
      if (!long || (width ?? 0) >= (height ?? 0)) ctx.resize({ width: MAX_EDGE });
      else ctx.resize({ height: MAX_EDGE });
    }
    const ref = await ctx.renderAsync();
    const saved = await ref.saveAsync({ format: SaveFormat.JPEG, compress: 0.85, base64: true });
    base64 = saved.base64 ?? undefined;
    width = saved.width;
    height = saved.height;
  } catch {
    // Could not re-encode: a data URI can still be sent as it is.
    if (img.uri.startsWith('data:')) base64 = img.uri.split(',')[1];
  }
  if (!base64) throw new Error('Could not read that image.');
  if (base64.length * 0.75 > AGENT_LIMITS.maxImageBytes) throw new Error('That image is too large.');
  return agentApi<AgentAttachment>('/api/agent/uploads', {
    method: 'POST',
    timeoutMs: 120_000,
    body: { name: img.name || 'photo.jpg', mime: 'image/jpeg', data: base64, width, height },
  });
}

/** Bytes of an uploaded attachment, for showing thumbnails with the session header. */
export async function attachmentSource(id: string): Promise<{ uri: string; headers: Record<string, string> }> {
  const { base, headers } = await creds();
  return { uri: joinUrl(base, `/api/agent/uploads/${id}`), headers };
}

// ─── The hook ───────────────────────────────────────────────────────────────

export interface AgentStatus { configured: boolean; model: string | null }

export interface PhoneAgentState {
  status: AgentStatus | null;
  list: AgentConversationSummary[];
  activeId: string | null;
  conversation: AgentConversation | null;
  liveText: string;
  liveThinking: string;
  online: boolean;
  error: string | null;
}

/** `onTab`: the assistant tab is selected (an overlay may still cover it). */
export function usePhoneAgent(visible: boolean, onTab = visible) {
  const [state, setState] = useState<PhoneAgentState>({
    status: null, list: [], activeId: null, conversation: null, liveText: '', liveThinking: '', online: false, error: null,
  });
  const activeRef = useRef<string | null>(null);
  activeRef.current = state.activeId;
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', s => setAppActive(s === 'active'));
    return () => sub.remove();
  }, []);

  // Every visit starts on a fresh screen; old chats are in the history. A
  // reply still being written is the exception: it stays in view. The key
  // older builds used to reopen the last chat is cleared once.
  useEffect(() => { SecureStore.deleteItemAsync(ACTIVE_KEY).catch(() => {}); }, []);
  const wasOnTab = useRef(onTab);
  useEffect(() => {
    if (onTab && !wasOnTab.current) {
      setState(s => (s.conversation?.state === 'running' ? s
        : { ...s, activeId: null, conversation: null, liveText: '', liveThinking: '', error: null }));
    }
    wasOnTab.current = onTab;
  }, [onTab]);

  const setError = useCallback((error: string | null) => setState(s => ({ ...s, error })), []);

  const refreshConversation = useCallback(async (id: string) => {
    try {
      const c = await agentApi<AgentConversation>(`/api/agent/conversations/${id}`);
      setState(s => (s.activeId === id ? { ...s, conversation: c, liveText: c.liveText ?? '', liveThinking: c.liveThinking ?? '', online: true } : s));
    } catch (err) {
      if (err instanceof AgentHttpError && err.status === 404) {
        setState(s => (s.activeId === id ? { ...s, activeId: null, conversation: null } : s));
      } else {
        setState(s => ({ ...s, online: false }));
      }
    }
  }, []);

  // Status, list and the active conversation whenever the screen is shown.
  useEffect(() => {
    if (!visible || !appActive) return;
    agentApi<AgentStatus>('/api/agent/status').then(status => setState(s => ({ ...s, status, online: true }))).catch(() => setState(s => ({ ...s, online: false })));
    agentApi<{ conversations: AgentConversationSummary[] }>('/api/agent/conversations')
      .then(r => setState(s => ({ ...s, list: r.conversations })))
      .catch(() => {});
    if (state.activeId) refreshConversation(state.activeId);
  }, [visible, appActive, state.activeId, refreshConversation]);

  // The live stream. Only while the screen is visible and the app in front.
  useEffect(() => {
    if (!visible || !appActive) return;
    let stopped = false;
    let controller: AbortController | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let fallbackPoll: ReturnType<typeof setInterval> | null = null;

    const handle = (ev: AgentStreamEvent) => {
      if (ev.type === 'list') {
        setState(s => ({ ...s, list: ev.conversations }));
      } else if (ev.type === 'conversation') {
        if (ev.conversation.id !== activeRef.current) return;
        setState(s => ({ ...s, conversation: ev.conversation, liveText: ev.conversation.liveText ?? '', liveThinking: ev.conversation.liveThinking ?? '' }));
      } else if (ev.type === 'delta') {
        if (ev.conversationId !== activeRef.current) return;
        setState(s => ({ ...s, liveText: s.liveText + (ev.text ?? ''), liveThinking: s.liveThinking + (ev.thinking ?? '') }));
      }
    };

    const open = async () => {
      try {
        const { base, headers } = await creds();
        controller = new AbortController();
        const q = state.activeId ? `?conversation=${encodeURIComponent(state.activeId)}` : '';
        const res = await streamFetch(joinUrl(base, `/api/agent/stream${q}`), {
          headers: { ...headers, Accept: 'text/event-stream' },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        setState(s => ({ ...s, online: true }));
        if (fallbackPoll) { clearInterval(fallbackPoll); fallbackPoll = null; }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done || stopped) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const data = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!data) continue;
            try { handle(JSON.parse(data)); } catch { /* partial or foreign frame */ }
          }
        }
      } catch {
        if (stopped) return;
        setState(s => ({ ...s, online: false }));
        // Keep the screen right while the stream is down.
        if (!fallbackPoll) {
          fallbackPoll = setInterval(() => {
            const id = activeRef.current;
            if (id) refreshConversation(id);
          }, 2500);
        }
      }
      if (!stopped) retry = setTimeout(open, 3000);
    };
    open();
    return () => {
      stopped = true;
      controller?.abort();
      if (retry) clearTimeout(retry);
      if (fallbackPoll) clearInterval(fallbackPoll);
    };
  }, [visible, appActive, state.activeId, refreshConversation]);

  const select = useCallback((id: string | null) => {
    setState(s => ({ ...s, activeId: id, conversation: null, liveText: '', liveThinking: '', error: null }));
  }, []);

  const newChat = useCallback(async () => {
    const c = await agentApi<AgentConversation>('/api/agent/conversations', { method: 'POST', body: {} });
    setState(s => ({ ...s, activeId: c.id, conversation: c, liveText: '', liveThinking: '', error: null }));
    return c;
  }, []);

  const send = useCallback(async (text: string, attachmentIds: string[]) => {
    let id = activeRef.current;
    if (!id) id = (await newChat()).id;
    await agentApi(`/api/agent/conversations/${id}/messages`, { method: 'POST', body: { text, attachmentIds } });
    refreshConversation(id);
  }, [newChat, refreshConversation]);

  const answer = useCallback(async (answers: AgentQuestionAnswer[]) => {
    const id = activeRef.current; if (!id) return;
    await agentApi(`/api/agent/conversations/${id}/answer`, { method: 'POST', body: { answers } });
    refreshConversation(id);
  }, [refreshConversation]);

  const decide = useCallback(async (approved: boolean) => {
    const id = activeRef.current; if (!id) return;
    await agentApi(`/api/agent/conversations/${id}/approval`, { method: 'POST', body: { approved } });
    refreshConversation(id);
  }, [refreshConversation]);

  const undo = useCallback(async (changeSetIds: string[]) => {
    const id = activeRef.current; if (!id) return;
    for (const cs of changeSetIds) {
      await agentApi(`/api/agent/conversations/${id}/undo`, { method: 'POST', body: { changeSetId: cs } });
    }
    refreshConversation(id);
  }, [refreshConversation]);

  const stop = useCallback(async () => {
    const id = activeRef.current; if (!id) return;
    await agentApi(`/api/agent/conversations/${id}/stop`, { method: 'POST', body: {} }).catch(() => {});
  }, []);

  const remove = useCallback(async (id: string) => {
    await agentApi(`/api/agent/conversations/${id}`, { method: 'DELETE' });
    if (activeRef.current === id) select(null);
    setState(s => ({ ...s, list: s.list.filter(c => c.id !== id) }));
  }, [select]);

  return { ...state, select, newChat, send, answer, decide, undo, stop, remove, setError };
}
