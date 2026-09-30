// ─── Planner agent: the browser side of the wire ─────────────────────────────
//
// One EventSource per open panel carries everything: the conversation list,
// whole-conversation snapshots after every durable change, and token deltas
// while a reply is being written. Actions are plain POSTs; their effects
// arrive back over the stream, so every window (and the phone) stays in step
// without any of them polling.

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  AgentAttachment, AgentConversation, AgentConversationSummary, AgentQuestionAnswer, AgentStreamEvent,
} from './agentTypes';
import { AGENT_LIMITS } from './agentTypes';

export interface AgentStatus {
  configured: boolean;
  model: string | null;
  dictation: boolean;
}

// The open chat used to be remembered and reopened on every visit; it no
// longer is. Clear the key older builds left behind.
try { localStorage.removeItem('planner-agent-active-conversation'); } catch { /* private mode */ }

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as { error?: string }).error || `Request failed (${res.status})`);
  return body as T;
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export interface PendingAttachment {
  localId: string;
  name: string;
  kind: 'image' | 'text';
  previewUrl?: string;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
  uploaded?: AgentAttachment;
}

const MAX_EDGE = 2560;
const REENCODE_OVER_BYTES = 4 * 1024 * 1024;

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/**
 * Shrink big photos before they travel. Screenshots are usually small enough
 * to send untouched, which keeps small text sharp; a 12 MP phone photo is not,
 * and the model reads a 2560 px image just as well.
 */
async function prepareImage(file: Blob): Promise<{ blob: Blob; mime: string; width?: number; height?: number }> {
  let bitmap: ImageBitmap | null = null;
  try { bitmap = await createImageBitmap(file); } catch { return { blob: file, mime: file.type || 'image/png' }; }
  const { width, height } = bitmap;
  const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  if (scale === 1 && file.size <= REENCODE_OVER_BYTES && /^image\/(png|jpe?g|webp)$/.test(file.type)) {
    bitmap.close();
    return { blob: file, mime: file.type, width, height };
  }
  const w = Math.round(width * scale);
  const h = Math.round(height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) { bitmap.close(); return { blob: file, mime: file.type, width, height }; }
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  const blob = await new Promise<Blob | null>(r => canvas.toBlob(r, 'image/jpeg', 0.9));
  return blob ? { blob, mime: 'image/jpeg', width: w, height: h } : { blob: file, mime: file.type, width, height };
}

const TEXT_EXT = /\.(txt|md|csv|json|ics|xml|log)$/i;

export function classifyFile(file: File): 'image' | 'text' | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('text/') || TEXT_EXT.test(file.name) || /json|xml|csv/.test(file.type)) return 'text';
  return null;
}

export async function uploadFile(file: File): Promise<AgentAttachment> {
  const kind = classifyFile(file);
  if (!kind) throw new Error(`"${file.name}" is not an image or a text file.`);
  if (kind === 'text' && file.size > AGENT_LIMITS.maxTextBytes) throw new Error(`"${file.name}" is larger than 400 KB.`);
  const prepared = kind === 'image' ? await prepareImage(file) : { blob: file as Blob, mime: file.type || 'text/plain' };
  if (kind === 'image' && prepared.blob.size > AGENT_LIMITS.maxImageBytes) throw new Error(`"${file.name}" is too large even after resizing.`);
  const data = await blobToBase64(prepared.blob);
  return api<AgentAttachment>('/api/agent/uploads', {
    method: 'POST',
    body: JSON.stringify({
      name: file.name || (kind === 'image' ? 'pasted-image.png' : 'file.txt'),
      mime: prepared.mime,
      data,
      ...('width' in prepared && prepared.width ? { width: prepared.width, height: prepared.height } : {}),
    }),
  });
}

// ─── The hook ────────────────────────────────────────────────────────────────

export interface AgentState {
  status: AgentStatus | null;
  list: AgentConversationSummary[];
  activeId: string | null;
  conversation: AgentConversation | null;
  liveText: string;
  liveThinking: string;
  connected: boolean;
  error: string | null;
}

export function useAgent(enabled: boolean) {
  const [state, setState] = useState<AgentState>({
    status: null, list: [], activeId: null, conversation: null,
    liveText: '', liveThinking: '', connected: false, error: null,
  });
  const activeRef = useRef(state.activeId);
  activeRef.current = state.activeId;

  // Every open starts on a fresh screen; old chats are one click away in the
  // history. A reply still being written is the exception: it stays in view.
  const wasEnabled = useRef(enabled);
  useEffect(() => {
    if (enabled && !wasEnabled.current) {
      setState(s => (s.conversation?.state === 'running' ? s
        : { ...s, activeId: null, conversation: null, liveText: '', liveThinking: '', error: null }));
    }
    wasEnabled.current = enabled;
  }, [enabled]);

  // Status (is a key configured, which model, can this device dictate via Windows).
  useEffect(() => {
    if (!enabled) return;
    api<AgentStatus>('/api/agent/status').then(status => setState(s => ({ ...s, status }))).catch(() => {});
  }, [enabled]);

  // The stream. Re-opened when the active conversation changes so the server
  // sends that conversation's snapshot first.
  useEffect(() => {
    if (!enabled) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    const open = () => {
      const q = state.activeId ? `?conversation=${encodeURIComponent(state.activeId)}` : '';
      es = new EventSource(`/api/agent/stream${q}`);
      es.onopen = () => setState(s => ({ ...s, connected: true }));
      es.onmessage = (msg) => {
        let ev: AgentStreamEvent;
        try { ev = JSON.parse(msg.data); } catch { return; }
        if (ev.type === 'list') {
          setState(s => {
            // A chat deleted elsewhere closes here too.
            const gone = s.activeId && !ev.conversations.some(c => c.id === s.activeId);
            return { ...s, list: ev.conversations, ...(gone ? { activeId: null, conversation: null } : {}) };
          });
        } else if (ev.type === 'conversation') {
          if (ev.conversation.id !== activeRef.current) return;
          setState(s => ({
            ...s,
            conversation: ev.conversation,
            liveText: ev.conversation.liveText ?? '',
            liveThinking: ev.conversation.liveThinking ?? '',
          }));
        } else if (ev.type === 'delta') {
          if (ev.conversationId !== activeRef.current) return;
          setState(s => ({
            ...s,
            liveText: s.liveText + (ev.text ?? ''),
            liveThinking: s.liveThinking + (ev.thinking ?? ''),
          }));
        }
      };
      es.onerror = () => {
        setState(s => ({ ...s, connected: false }));
        es?.close();
        if (!closed) retry = setTimeout(open, 2500);
      };
    };
    open();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [enabled, state.activeId]);

  const setError = useCallback((error: string | null) => setState(s => ({ ...s, error })), []);

  const select = useCallback((id: string | null) => {
    setState(s => ({ ...s, activeId: id, conversation: null, liveText: '', liveThinking: '', error: null }));
    if (id) {
      api<AgentConversation>(`/api/agent/conversations/${id}`)
        .then(c => setState(s => (s.activeId === id ? { ...s, conversation: c, liveText: c.liveText ?? '', liveThinking: c.liveThinking ?? '' } : s)))
        .catch(() => { setState(s => (s.activeId === id ? { ...s, activeId: null } : s)); });
    }
  }, []);

  const newChat = useCallback(async () => {
    const c = await api<AgentConversation>('/api/agent/conversations', { method: 'POST', body: '{}' });
    setState(s => ({ ...s, activeId: c.id, conversation: c, liveText: '', liveThinking: '', error: null }));
    return c;
  }, []);

  const send = useCallback(async (text: string, attachmentIds: string[]) => {
    setError(null);
    let id = activeRef.current;
    if (!id) id = (await newChat()).id;
    await api(`/api/agent/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify({ text, attachmentIds }) });
  }, [newChat, setError]);

  const answer = useCallback(async (answers: AgentQuestionAnswer[]) => {
    const id = activeRef.current; if (!id) return;
    setError(null);
    await api(`/api/agent/conversations/${id}/answer`, { method: 'POST', body: JSON.stringify({ answers }) });
  }, [setError]);

  const decide = useCallback(async (approved: boolean) => {
    const id = activeRef.current; if (!id) return;
    setError(null);
    await api(`/api/agent/conversations/${id}/approval`, { method: 'POST', body: JSON.stringify({ approved }) });
  }, [setError]);

  const undo = useCallback(async (changeSetId: string) => {
    const id = activeRef.current; if (!id) return null;
    return api<{ restored: number; skipped: number }>(`/api/agent/conversations/${id}/undo`, { method: 'POST', body: JSON.stringify({ changeSetId }) });
  }, []);

  const stop = useCallback(async () => {
    const id = activeRef.current; if (!id) return;
    await api(`/api/agent/conversations/${id}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
  }, []);

  const remove = useCallback(async (id: string) => {
    await api(`/api/agent/conversations/${id}`, { method: 'DELETE' });
    if (activeRef.current === id) select(null);
  }, [select]);

  const rename = useCallback(async (id: string, title: string) => {
    await api(`/api/agent/conversations/${id}/rename`, { method: 'POST', body: JSON.stringify({ title }) });
  }, []);

  return { ...state, select, newChat, send, answer, decide, undo, stop, remove, rename, setError };
}

// ─── Dictation ───────────────────────────────────────────────────────────────

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean;
  start: () => void; stop: () => void; abort: () => void;
  onresult: ((e: any) => void) | null; onerror: ((e: any) => void) | null; onend: (() => void) | null;
};

export function speechRecognitionCtor(): (new () => Recognition) | null {
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Start listening. Returns a stop function. `onText` receives the running
 * transcript (final + interim) so the box can show words as they are heard.
 * Calls `onFail` when the engine refuses (no permission, no service), so the
 * caller can fall back to Windows voice typing.
 */
export function startDictation(
  lang: string,
  onText: (finalText: string, interim: string) => void,
  onEnd: () => void,
  onFail: (reason: string) => void,
): (() => void) | null {
  const Ctor = speechRecognitionCtor();
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = lang;
  rec.continuous = true;
  rec.interimResults = true;
  let finalText = '';
  rec.onresult = (e: any) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    onText(finalText, interim);
  };
  rec.onerror = (e: any) => onFail(String(e?.error ?? 'error'));
  rec.onend = onEnd;
  try { rec.start(); } catch (err) { onFail(String(err)); return null; }
  return () => { try { rec.stop(); } catch { /* already stopped */ } };
}

export async function windowsDictation(): Promise<void> {
  await api('/api/agent/dictate', { method: 'POST', body: '{}' });
}
