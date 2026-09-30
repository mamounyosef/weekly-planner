// The planner assistant: a chat that can read and change the planner through
// a fixed set of tools. Docked beside the calendar on a wide screen, floating
// over it when the screen is too narrow to share, and full screen on a phone.
// Everything it shows arrives from the server over one stream, so a reply
// started on the PC can be watched finishing on the phone and the other way.

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowUp, Brain, CalendarSearch, Camera, Check, ChevronDown, ChevronRight, CircleAlert, CircleHelp,
  Clock, FileText, History, ImagePlus, ListChecks, Loader2, Mic, MicOff, Paperclip, Pencil, Plus, Search,
  Square, Trash2, Wand2, X,
} from 'lucide-react';

import type { AgentConversation, AgentMessage, AgentToolTrace } from '@/lib/agent/agentTypes';
import { AGENT_LIMITS } from '@/lib/agent/agentTypes';
import {
  classifyFile, speechRecognitionCtor, startDictation, uploadFile, useAgent, windowsDictation,
  type PendingAttachment,
} from '@/lib/agent/agentClient';
import AgentMarkdown from './AgentMarkdown';
import AgentOrb from './AgentOrb';
import { ApprovalCard, ErrorNote, QuestionCard, ReportCard, type AgentTheme } from './AgentCards';

export type { AgentTheme } from './AgentCards';

interface AgentPanelProps {
  open: boolean;
  onClose: () => void;
  theme: AgentTheme;
  timeFormat: '12h' | '24h';
  /** Phone-sized screen: full-screen overlay instead of a docked panel. */
  fullscreen: boolean;
  /** Too narrow to sit beside the calendar: float over it instead of squeezing it. */
  floating?: boolean;
  width: number;
  onResize: (w: number) => void;
  /** Show a day in the calendar (from a report's day heading). */
  onOpenDate?: (date: string) => void;
}

const EXAMPLES = [
  { icon: ImagePlus, title: 'From a screenshot', text: 'Add the schedule in this screenshot to my calendar' },
  { icon: Clock, title: 'My day', text: 'What do I have tomorrow?' },
  { icon: Pencil, title: 'Change something', text: 'Move my gym session today to 8 PM' },
  { icon: Wand2, title: 'Plan for me', text: 'Find 2 free hours on Friday to study and book them' },
];

const TOOL_ICON: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  list_items: CalendarSearch,
  search_items: Search,
  find_free_time: Clock,
  create_events: Plus,
  update_events: Pencil,
  create_tasks: ListChecks,
  update_tasks: ListChecks,
  delete_items: Trash2,
  ask_user: CircleHelp,
};

/** Keyframes the panel needs, injected once (Tailwind has no caret or shimmer). */
const PANEL_CSS = `
@keyframes agent-caret { 0%, 49% { opacity: 1 } 50%, 100% { opacity: 0 } }
@keyframes agent-shimmer { 0% { background-position: -200% 0 } 100% { background-position: 200% 0 } }
@keyframes agent-in { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
.agent-caret::after { content: ''; display: inline-block; width: 7px; height: 1.05em; margin-left: 2px; vertical-align: -0.15em; border-radius: 2px; background: currentColor; animation: agent-caret 1s steps(1) infinite; }
.agent-shimmer { background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent !important; animation: agent-shimmer 2.2s linear infinite; }
.agent-in { animation: agent-in 180ms ease-out both; }
.agent-panel textarea:focus-visible, .agent-panel input:focus-visible { box-shadow: none !important; outline: none !important; }
.agent-scroll::-webkit-scrollbar { width: 6px } .agent-scroll::-webkit-scrollbar-thumb { border-radius: 3px; background: rgba(127,127,127,0.25) }
.agent-scroll::-webkit-scrollbar-track { background: transparent }
.agent-example { transition: border-color 140ms ease, transform 140ms ease, box-shadow 140ms ease; }
.agent-example:hover { border-color: color-mix(in srgb, var(--agent-accent) 55%, transparent) !important; transform: translateY(-1px); box-shadow: 0 6px 18px rgba(0,0,0,0.12); }
.agent-example:active { transform: translateY(0) scale(0.99); }
.agent-composer { transition: border-color 140ms ease, box-shadow 160ms ease; }
.agent-composer:focus-within { border-color: color-mix(in srgb, var(--agent-accent) 60%, transparent) !important; box-shadow: 0 0 0 3px color-mix(in srgb, var(--agent-accent) 18%, transparent), 0 10px 30px rgba(0,0,0,0.25) !important; }
.agent-scroll-fade { -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 10px), transparent 100%); mask-image: linear-gradient(to bottom, transparent 0, #000 14px, #000 calc(100% - 10px), transparent 100%); }
`;

let localSeq = 0;

export default function AgentPanel({ open, onClose, theme, timeFormat, fullscreen, floating, width, onResize, onOpenDate }: AgentPanelProps) {
  const agent = useAgent(open);
  const conv = agent.conversation;
  const busy = conv?.state === 'running';

  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<PendingAttachment[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [atBottom, setAtBottom] = useState(true);
  const stopDictationRef = useRef<(() => void) | null>(null);
  const dictationBaseRef = useRef('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  // ── Scrolling: follow the reply unless the user scrolled up to read. ──
  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    stickRef.current = near;
    setAtBottom(near);
  }, []);
  const scrollToEnd = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    stickRef.current = true;
    setAtBottom(true);
  }, []);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [conv, agent.liveText, agent.liveThinking]);
  useEffect(() => { stickRef.current = true; setAtBottom(true); }, [agent.activeId]);

  useEffect(() => {
    if (open && !fullscreen) setTimeout(() => inputRef.current?.focus(), 60);
  }, [open, fullscreen, agent.activeId]);

  // Esc closes the chat list, then the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (historyOpen) { setHistoryOpen(false); e.stopPropagation(); return; }
      if (floating || fullscreen) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, historyOpen, floating, fullscreen, onClose]);

  // ── Attachments ──
  const addFiles = useCallback((list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const kind = classifyFile(file);
      const localId = `f${++localSeq}`;
      if (!kind) {
        setFiles(f => [...f, { localId, name: file.name, kind: 'text', status: 'error', error: 'Only images and text files can be sent.' }]);
        continue;
      }
      const previewUrl = kind === 'image' ? URL.createObjectURL(file) : undefined;
      setFiles(f => (f.length >= AGENT_LIMITS.maxAttachments ? f
        : [...f, { localId, name: file.name || (kind === 'image' ? 'Pasted image' : 'File'), kind, previewUrl, status: 'uploading' }]));
      uploadFile(file)
        .then(uploaded => setFiles(f => f.map(x => (x.localId === localId ? { ...x, status: 'ready', uploaded } : x))))
        .catch(err => setFiles(f => f.map(x => (x.localId === localId ? { ...x, status: 'error', error: err?.message ?? 'Upload failed' } : x))));
    }
    inputRef.current?.focus();
  }, []);
  const removeFile = (localId: string) => setFiles(f => {
    const it = f.find(x => x.localId === localId);
    if (it?.previewUrl) URL.revokeObjectURL(it.previewUrl);
    return f.filter(x => x.localId !== localId);
  });

  const onPaste = useCallback((e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData?.files ?? []);
    if (items.length) { e.preventDefault(); addFiles(items); }
  }, [addFiles]);

  // ── Sending ──
  const uploading = files.some(f => f.status === 'uploading');
  const ready = files.filter(f => f.status === 'ready');
  const canSend = !sending && !uploading && (draft.trim().length > 0 || ready.length > 0) && agent.status?.configured !== false;

  const send = useCallback(async (override?: string) => {
    const text = (override ?? draft).trim();
    if (sending || uploading || (!text && !ready.length) || agent.status?.configured === false) return;
    stopDictationRef.current?.();
    setSending(true);
    agent.setError(null);
    try {
      await agent.send(text, ready.map(f => f.uploaded!.id));
      setDraft('');
      files.forEach(f => f.previewUrl && URL.revokeObjectURL(f.previewUrl));
      setFiles([]);
      stickRef.current = true;
      if (inputRef.current) inputRef.current.style.height = 'auto';
    } catch (err: any) {
      agent.setError(err?.message ?? 'Could not send.');
    } finally {
      setSending(false);
    }
  }, [draft, sending, uploading, ready, agent, files]);

  // ── Dictation ──
  const toggleMic = useCallback(async () => {
    if (listening) { stopDictationRef.current?.(); return; }
    const lang = /[؀-ۿ]/.test(draft) ? 'ar-JO' : (navigator.language || 'en-US');
    const fallbackToWindows = async () => {
      if (!agent.status?.dictation) { agent.setError('Voice input is not available in this browser.'); return; }
      inputRef.current?.focus();
      try { await windowsDictation(); } catch (e: any) { agent.setError(e?.message ?? 'Could not start Windows voice typing.'); }
    };
    if (!speechRecognitionCtor()) { await fallbackToWindows(); return; }
    dictationBaseRef.current = draft ? `${draft.replace(/\s+$/, '')} ` : '';
    let failed = false;
    const stop = startDictation(
      lang,
      (finalText, interimText) => { setDraft(dictationBaseRef.current + finalText); setInterim(interimText); },
      () => { setListening(false); setInterim(''); stopDictationRef.current = null; },
      (reason) => {
        if (failed) return;
        failed = true;
        setListening(false);
        if (reason === 'no-speech' || reason === 'aborted') return;
        void fallbackToWindows();
      },
    );
    if (stop) { stopDictationRef.current = stop; setListening(true); } else await fallbackToWindows();
  }, [listening, draft, agent]);
  useEffect(() => () => stopDictationRef.current?.(), []);

  // ── Resize (docked / floating) ──
  const onHandleDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let raf = 0;
    const move = (ev: MouseEvent) => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; onResize(Math.min(760, Math.max(360, startW + (startX - ev.clientX)))); });
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, [width, onResize]);

  const lastAssistant = useMemo(() => [...(conv?.messages ?? [])].reverse().find(m => m.role === 'assistant') ?? null, [conv]);
  const waitingOnUser = conv?.state === 'awaiting_answer' || conv?.state === 'awaiting_approval';
  const statusLine = agent.status?.configured === false
    ? 'Not set up'
    : busy ? 'Working on it'
      : waitingOnUser ? 'Waiting for you'
        : agent.connected ? 'Ready' : 'Connecting';

  const shellStyle: React.CSSProperties = fullscreen
    ? {
      position: 'fixed', inset: 0, zIndex: 140, background: theme.bg,
      paddingTop: 'var(--safe-top, 0px)', paddingBottom: 'var(--safe-bottom, 0px)',
      display: open ? 'flex' : 'none',
    }
    : floating
      ? {
        position: 'absolute', top: 0, right: 0, bottom: 0, zIndex: 95,
        width, background: theme.bg,
        borderTopLeftRadius: 16, borderBottomLeftRadius: 16,
        transform: open ? 'none' : 'translateX(105%)',
        transition: 'transform 180ms cubic-bezier(0.16, 1, 0.3, 1)',
        borderLeft: `1px solid ${theme.bdr}`,
        boxShadow: open ? '-18px 0 48px rgba(0,0,0,0.28)' : 'none',
        pointerEvents: open ? 'auto' : 'none',
      }
      : {
        width: open ? width : 0,
        transition: 'width 130ms cubic-bezier(0.16, 1, 0.3, 1)',
        borderLeft: open ? `1px solid ${theme.bdr}` : 'none',
        background: theme.bg,
      };

  // Sky to ocean blue: bright enough to read as the assistant at a glance,
  // calm enough to sit beside the calendar's own colours all day.
  const gradient = theme.darkMode
    ? 'linear-gradient(135deg, #38bdf8 0%, #0ea5e9 45%, #2563eb 100%)'
    : 'linear-gradient(135deg, #38bdf8 0%, #0284c7 55%, #1d4ed8 100%)';

  const panel = (
    <aside
      className={`agent-panel ${fullscreen ? 'flex-col' : floating ? 'overflow-hidden' : 'flex-shrink-0 overflow-hidden relative shadow-lg'}`}
      style={shellStyle}
      aria-hidden={!open}
      onDragOver={e => { if (e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={e => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={e => { e.preventDefault(); setDragOver(false); if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); }}
    >
      <style>{PANEL_CSS}</style>
      <div className="h-full flex flex-col relative" style={{ width: fullscreen ? '100%' : width }}>
        {!fullscreen && (
          <div
            onMouseDown={onHandleDown}
            className="absolute left-0 top-0 bottom-0 w-1.5 cursor-col-resize z-30"
            onMouseEnter={e => (e.currentTarget.style.background = `${theme.accent}55`)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title="Drag to resize"
          />
        )}

        {/* Header */}
        <div className="flex-shrink-0 flex items-center gap-2.5 px-3.5 h-14 relative" style={{ background: theme.bg }}>
          <div className="absolute left-3 right-3 bottom-0 h-px pointer-events-none" style={{ background: `linear-gradient(90deg, transparent, ${theme.bdr} 15%, ${theme.bdr} 85%, transparent)` }} />
          <AgentOrb size={26} busy={busy} />
          <button type="button" onClick={() => setHistoryOpen(v => !v)} className="min-w-0 flex-1 text-left rounded-lg px-1 py-0.5 transition-colors" title="Your chats" style={{ background: historyOpen ? theme.hover : undefined }}>
            <div className="text-[13.5px] font-bold truncate flex items-center gap-1" style={{ color: theme.text }}>
              <span className="truncate" dir="auto">{historyOpen ? 'Your chats' : conv?.messages.length ? conv.title : 'Assistant'}</span>
              <ChevronDown size={13} className="flex-shrink-0 transition-transform" style={{ color: theme.sub, transform: historyOpen ? 'rotate(180deg)' : undefined }} />
            </div>
            <div className="text-[11px] truncate flex items-center gap-1.5" style={{ color: theme.sub }}>
              <span className="inline-block rounded-full flex-shrink-0" style={{ width: 6, height: 6, background: agent.status?.configured === false ? '#ef4444' : waitingOnUser ? '#f59e0b' : agent.connected ? '#22c55e' : '#94a3b8' }} />
              {statusLine}
            </div>
          </button>
          <HeaderButton theme={theme} title="New chat" onClick={() => { agent.newChat(); setHistoryOpen(false); setTimeout(() => inputRef.current?.focus(), 50); }}><Plus size={16} /></HeaderButton>
          <HeaderButton theme={theme} title="Your chats" active={historyOpen} onClick={() => setHistoryOpen(v => !v)}><History size={15} /></HeaderButton>
          <HeaderButton theme={theme} title="Close (Esc)" onClick={onClose}><X size={16} /></HeaderButton>
        </div>

        {historyOpen && (
          <HistoryList
            theme={theme}
            items={agent.list}
            activeId={agent.activeId}
            onPick={id => { agent.select(id); setHistoryOpen(false); }}
            onDelete={id => agent.remove(id)}
            onRename={(id, t) => agent.rename(id, t)}
            onNew={() => { agent.newChat(); setHistoryOpen(false); }}
          />
        )}

        {/* Messages */}
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="agent-scroll agent-scroll-fade flex-1 overflow-y-auto overscroll-contain px-4 py-5 space-y-6"
          style={{ display: historyOpen ? 'none' : undefined }}
        >
          {agent.status?.configured === false && (
            <ErrorNote theme={theme} text="The assistant has no Ollama API key. Add OLLAMA_API_KEY to the .env file in the planner folder on the PC." />
          )}
          {!conv?.messages.length && (
            <EmptyState theme={theme} gradient={gradient} onPick={t => { setDraft(t); inputRef.current?.focus(); }} />
          )}
          {conv?.messages.map(m => (
            m.role === 'user'
              ? <UserBubble key={m.id} m={m} theme={theme} />
              : (
                <AssistantBlock
                  key={m.id}
                  m={m}
                  conv={conv}
                  isLast={m.id === lastAssistant?.id}
                  liveText={m.id === lastAssistant?.id && busy ? agent.liveText : ''}
                  liveThinking={m.id === lastAssistant?.id && busy ? agent.liveThinking : ''}
                  theme={theme}
                  gradient={gradient}
                  timeFormat={timeFormat}
                  onAnswer={agent.answer}
                  onDecide={agent.decide}
                  onUndo={async ids => { for (const id of ids) await agent.undo(id); }}
                  onOpenDate={onOpenDate}
                />
              )
          ))}
          {agent.error && <ErrorNote theme={theme} text={agent.error} />}
        </div>

        {!historyOpen && !atBottom && (
          <button
            type="button"
            onClick={() => scrollToEnd()}
            className="absolute left-1/2 -translate-x-1/2 z-20 rounded-full px-3 py-1.5 text-[11.5px] font-semibold flex items-center gap-1.5 shadow-lg agent-in"
            style={{ bottom: 118 + (files.length ? 70 : 0), background: theme.surface, color: theme.text, border: `1px solid ${theme.bdr}` }}
          >
            <ArrowDown size={12} /> {busy ? 'Follow the reply' : 'Latest'}
          </button>
        )}

        {/* Composer */}
        {!historyOpen && (
          <div className="flex-shrink-0 px-3 pt-2 pb-3" style={{ background: `linear-gradient(to top, ${theme.bg} 70%, transparent)` }}>
            <div
              className="rounded-[24px] flex flex-col agent-composer"
              style={{
                ['--agent-accent' as any]: listening ? '#ef4444' : theme.accent,
                border: `1px solid ${listening ? '#ef4444' : theme.bdr}`,
                background: theme.surface,
                boxShadow: theme.darkMode ? '0 10px 30px rgba(0,0,0,0.35)' : '0 10px 28px rgba(15,23,42,0.08)',
              }}
            >
              {files.length > 0 && (
                <div className="flex gap-2 overflow-x-auto px-2.5 pt-2.5">
                  {files.map(f => (
                    <div key={f.localId} className="relative flex-shrink-0 rounded-xl overflow-hidden" style={{ border: `1px solid ${f.status === 'error' ? '#ef4444' : theme.bdr}`, width: 60, height: 60 }} title={f.error ?? f.name}>
                      {f.previewUrl
                        ? <img src={f.previewUrl} alt={f.name} className="w-full h-full object-cover" />
                        : <div className="w-full h-full flex flex-col items-center justify-center gap-1 px-1" style={{ color: theme.sub }}><FileText size={16} /><span className="text-[9px] truncate w-full text-center">{f.name}</span></div>}
                      {f.status === 'uploading' && <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(0,0,0,0.4)' }}><Loader2 size={16} className="animate-spin text-white" /></div>}
                      {f.status === 'error' && <div className="absolute inset-0 flex items-center justify-center" style={{ background: 'rgba(239,68,68,0.4)' }}><CircleAlert size={16} className="text-white" /></div>}
                      {f.status === 'ready' && <div className="absolute bottom-0.5 left-0.5 rounded-full p-0.5" style={{ background: '#22c55e' }}><Check size={8} className="text-white" strokeWidth={4} /></div>}
                      <button type="button" onClick={() => removeFile(f.localId)} className="absolute top-0.5 right-0.5 rounded-full p-0.5" style={{ background: 'rgba(0,0,0,0.65)' }} title="Remove">
                        <X size={11} className="text-white" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={inputRef}
                value={draft + (interim ? `${draft && !draft.endsWith(' ') ? ' ' : ''}${interim}` : '')}
                onChange={e => { setDraft(e.target.value); setInterim(''); }}
                onPaste={onPaste}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); }
                  if (e.key !== 'Escape') e.stopPropagation(); // keep the calendar's shortcuts out of the text box
                }}
                rows={1}
                dir="auto"
                placeholder={listening ? 'Listening...' : conv?.state === 'awaiting_answer' ? 'Answer above, or type a reply' : conv?.state === 'awaiting_approval' ? 'Approve above, or tell me what to do instead' : 'Ask anything, or paste a screenshot'}
                className="w-full resize-none bg-transparent outline-none px-3.5 pt-3 pb-1 text-[13.5px] leading-relaxed"
                style={{ color: theme.text, maxHeight: 200, minHeight: 44 }}
                onInput={e => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = `${Math.min(200, t.scrollHeight)}px`; }}
              />
              <div className="flex items-center gap-0.5 px-2 pb-2">
                <input ref={fileInputRef} type="file" multiple accept="image/*,text/*,.csv,.md,.json,.ics,.txt" className="hidden"
                  onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
                <input ref={cameraInputRef} type="file" accept="image/*" capture="environment" className="hidden"
                  onChange={e => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
                <ComposerButton theme={theme} title="Attach images or text files (or paste, or drop them here)" onClick={() => fileInputRef.current?.click()}><Paperclip size={16} /></ComposerButton>
                {fullscreen && <ComposerButton theme={theme} title="Take a photo" onClick={() => cameraInputRef.current?.click()}><Camera size={16} /></ComposerButton>}
                <ComposerButton theme={theme} title={listening ? 'Stop listening' : 'Speak'} active={listening} danger={listening} onClick={toggleMic}>
                  {listening ? <MicOff size={16} /> : <Mic size={16} />}
                </ComposerButton>
                <div className="flex-1 text-[10.5px] text-right pr-2 truncate" style={{ color: theme.sub }}>
                  {!fullscreen && !busy && (draft ? 'Enter to send, Shift+Enter for a new line' : '')}
                </div>
                {busy ? (
                  <button type="button" onClick={agent.stop} title="Stop" className="h-9 w-9 rounded-full flex items-center justify-center" style={{ background: theme.text }}>
                    <Square size={12} fill={theme.bg} color={theme.bg} />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => send()}
                    disabled={!canSend}
                    title="Send (Enter)"
                    className="h-9 w-9 rounded-full flex items-center justify-center text-white transition-all"
                    style={{ background: canSend ? gradient : theme.hover, color: canSend ? '#fff' : theme.sub, transform: canSend ? 'scale(1)' : 'scale(0.94)' }}
                  >
                    {sending || uploading ? <Loader2 size={15} className="animate-spin" /> : <ArrowUp size={16} strokeWidth={2.5} />}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {dragOver && (
          <div className="absolute inset-2 z-40 rounded-2xl flex flex-col items-center justify-center gap-2 pointer-events-none" style={{ background: `${theme.bg}e6`, border: `2px dashed ${theme.accent}` }}>
            <ImagePlus size={28} style={{ color: theme.accent }} />
            <div className="text-[14px] font-bold" style={{ color: theme.text }}>Drop to attach</div>
            <div className="text-[12px]" style={{ color: theme.sub }}>Screenshots, photos and text files</div>
          </div>
        )}
      </div>
    </aside>
  );
  // Full screen on a phone: rendered at the top of the page, or the bottom bar
  // and the add button (in the shell's own stacking context) draw over it.
  return fullscreen && typeof document !== 'undefined' ? createPortal(panel, document.body) : panel;
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

function HeaderButton({ theme, title, active, onClick, children }: {
  theme: AgentTheme; title: string; active?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="w-8 h-8 rounded-full flex items-center justify-center transition-colors flex-shrink-0"
      style={{ color: active ? theme.accent : theme.text, background: active ? `${theme.accent}22` : 'transparent' }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = theme.hover; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function ComposerButton({ theme, title, active, danger, onClick, children }: {
  theme: AgentTheme; title: string; active?: boolean; danger?: boolean; onClick: () => void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors ${danger ? 'animate-pulse' : ''}`}
      style={{ color: danger ? '#ef4444' : active ? theme.accent : theme.sub, background: danger ? 'rgba(239,68,68,0.12)' : 'transparent' }}
      onMouseEnter={e => { if (!danger) e.currentTarget.style.background = theme.hover; }}
      onMouseLeave={e => { if (!danger) e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function EmptyState({ theme, onPick }: { theme: AgentTheme; gradient?: string; onPick: (t: string) => void }) {
  return (
    <div className="pt-10 pb-2 space-y-7 agent-in">
      <div className="space-y-3 px-1">
        <AgentOrb size={44} />
        <div className="text-[22px] font-semibold tracking-tight leading-tight" style={{ color: theme.text }}>
          {greeting()}.<br /><span style={{ color: theme.sub }}>What should we plan?</span>
        </div>
      </div>
      <div className="space-y-2">
        {EXAMPLES.map((ex, i) => (
          <button
            key={ex.text}
            type="button"
            onClick={() => onPick(ex.text)}
            className="agent-example agent-in w-full text-left rounded-2xl pl-2 pr-3 py-2 flex items-center gap-3 group"
            style={{ border: `1px solid ${theme.bdr}`, background: theme.surface, animationDelay: `${60 + i * 45}ms`, animationFillMode: 'backwards',['--agent-accent' as any]: theme.accent }}
          >
            <span className="flex-shrink-0 w-8 h-8 rounded-xl flex items-center justify-center" style={{ background: `${theme.accent}1f`, color: theme.accent }}>
              <ex.icon size={15} />
            </span>
            <span className="flex-1 min-w-0 text-[13px] leading-snug" style={{ color: theme.text }}>{ex.text}</span>
            <ArrowUp size={14} className="flex-shrink-0 rotate-45 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all" style={{ color: theme.sub }} />
          </button>
        ))}
      </div>
    </div>
  );
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function UserBubble({ m, theme }: { m: AgentMessage; theme: AgentTheme }) {
  return (
    <div className="flex flex-col items-end gap-1.5 agent-in group">
      {m.attachments && m.attachments.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5 max-w-[88%]">
          {m.attachments.map(a => (
            a.kind === 'image'
              ? (
                <a key={a.id} href={`/api/agent/uploads/${a.id}`} target="_blank" rel="noreferrer" className="block rounded-xl overflow-hidden shadow-sm transition-transform hover:scale-[1.02]" style={{ border: `1px solid ${theme.bdr}` }}>
                  <img src={`/api/agent/uploads/${a.id}`} alt={a.name} className="block object-cover" style={{ maxWidth: m.attachments!.length > 1 ? 150 : 240, maxHeight: 170 }} loading="lazy" />
                </a>
              )
              : (
                <div key={a.id} className="rounded-xl px-2.5 py-2 flex items-center gap-1.5 text-[11.5px]" style={{ border: `1px solid ${theme.bdr}`, color: theme.sub, background: theme.surface }}>
                  <FileText size={13} /> {a.name}
                </div>
              )
          ))}
        </div>
      )}
      {m.text && (
        <div
          className="max-w-[85%] rounded-[20px] rounded-br-md px-4 py-2.5 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words"
          dir="auto"
          style={{ background: `${theme.accent}1c`, border: `1px solid ${theme.accent}2e`, color: theme.text }}
        >
          {m.text}
        </div>
      )}
      <div className="text-[10px] opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: theme.sub }}>{timeOf(m.at)}</div>
    </div>
  );
}

function Steps({ tools, theme, running }: { tools: AgentToolTrace[]; theme: AgentTheme; running: boolean }) {
  const [open, setOpen] = useState(false);
  if (!tools.length) return null;
  const current = tools.find(t => t.status === 'running');
  const corrected = tools.filter(t => t.status === 'error' || t.status === 'rejected').length;
  const shown = open ? tools : current ? [current] : [];
  return (
    <div className="text-[11.5px]" style={{ color: theme.sub }}>
      <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors" onMouseEnter={e => (e.currentTarget.style.background = theme.hover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <ListChecks size={12} />
        <span>{tools.length} step{tools.length === 1 ? '' : 's'}{corrected ? ` (${corrected} self-corrected)` : ''}</span>
      </button>
      {shown.length > 0 && (
        <div className="mt-1.5 ml-1.5 pl-3 space-y-1.5" style={{ borderLeft: `1.5px solid ${theme.bdr}` }}>
          {shown.map(t => {
            const Icon = TOOL_ICON[t.name] ?? CircleAlert;
            const color = t.status === 'ok' ? theme.sub : t.status === 'running' ? theme.accent : '#f59e0b';
            return (
              <div key={t.id} className="flex items-start gap-2 agent-in">
                <span className="mt-px flex-shrink-0" style={{ color }}>
                  {t.status === 'running' ? <Loader2 size={12} className="animate-spin" /> : <Icon size={12} />}
                </span>
                <span className="min-w-0">
                  <span className={t.status === 'running' && running ? 'agent-shimmer' : undefined} style={t.status === 'running' ? { backgroundImage: `linear-gradient(90deg, ${theme.sub}, ${theme.text}, ${theme.sub})` } : { color }}>
                    {t.label}
                  </span>
                  {t.endedAt && open && <span className="ml-1.5 opacity-60 tabular-nums">{((t.endedAt - t.startedAt) / 1000).toFixed(1)}s</span>}
                  {t.error && open && <span className="block opacity-80 mt-0.5">{t.error}</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Thinking({ text, live, theme }: { text: string; live: boolean; theme: AgentTheme }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  return (
    <div className="text-[11.5px]" style={{ color: theme.sub }}>
      <button type="button" onClick={() => setOpen(v => !v)} className="flex items-center gap-1.5 rounded-md px-1 -mx-1 py-0.5 transition-colors" onMouseEnter={e => (e.currentTarget.style.background = theme.hover)} onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <Brain size={12} />
        <span className={live ? 'agent-shimmer' : undefined} style={live ? { backgroundImage: `linear-gradient(90deg, ${theme.sub}, ${theme.text}, ${theme.sub})` } : undefined}>
          {live ? 'Thinking' : 'Thought process'}
        </span>
      </button>
      {open && (
        <div className="mt-1.5 ml-1.5 pl-3 whitespace-pre-wrap leading-relaxed max-h-72 overflow-y-auto agent-scroll" style={{ borderLeft: `1.5px solid ${theme.bdr}` }} dir="auto">{text}</div>
      )}
    </div>
  );
}

function AssistantBlock({ m, conv, isLast, liveText, liveThinking, theme, gradient, timeFormat, onAnswer, onDecide, onUndo, onOpenDate }: {
  m: AgentMessage;
  conv: AgentConversation;
  isLast: boolean;
  liveText: string;
  liveThinking: string;
  theme: AgentTheme;
  gradient: string;
  timeFormat: '12h' | '24h';
  onAnswer: (a: NonNullable<AgentMessage['answers']>) => Promise<void>;
  onDecide: (approved: boolean) => Promise<void>;
  onUndo: (ids: string[]) => Promise<void>;
  onOpenDate?: (date: string) => void;
}) {
  const sets = (m.changeSetIds ?? []).map(id => conv.changeSets[id]).filter(Boolean);
  const running = isLast && conv.state === 'running';
  const text = [m.text, liveText].filter(Boolean).join(m.text && liveText ? '\n\n' : '');
  const thinking = [m.thinking, liveThinking].filter(Boolean).join('\n\n');
  const toolRunning = (m.tools ?? []).some(t => t.status === 'running');
  const nothingYet = !text && !sets.length && !m.questions && !m.approval && !m.error && !(m.tools ?? []).length && !thinking;

  return (
    <div className="agent-in">
      <div className="min-w-0 space-y-3">
        <Thinking text={thinking} live={running && !!liveThinking && !liveText} theme={theme} />
        <Steps tools={m.tools ?? []} theme={theme} running={running} />
        {text && (
          <div className={`text-[13.5px] ${running && !!liveText && !toolRunning ? 'agent-caret' : ''}`} style={{ color: theme.text }}>
            <AgentMarkdown text={text} color={theme.text} />
          </div>
        )}
        {running && nothingYet && (
          <div className="flex items-center gap-2.5">
            <AgentOrb size={18} busy />
            <span className="text-[12.5px] font-medium agent-shimmer" style={{ backgroundImage: `linear-gradient(90deg, ${theme.sub}, ${theme.text}, ${theme.sub})` }}>
              Reading your request
            </span>
          </div>
        )}
        {m.questions && (
          <QuestionCard questions={m.questions} answers={m.answers} active={isLast && conv.state === 'awaiting_answer' && !m.answers} theme={theme} onSubmit={onAnswer} />
        )}
        {m.approval && (
          <ApprovalCard approval={m.approval} decision={m.approvalDecision} active={isLast && conv.state === 'awaiting_approval'} theme={theme} onDecide={onDecide} />
        )}
        {sets.length > 0 && <ReportCard sets={sets} timeFormat={timeFormat} theme={theme} onUndo={onUndo} onOpenDate={onOpenDate} />}
        {m.error && <ErrorNote theme={theme} text={m.error} />}
      </div>
    </div>
  );
}

function HistoryList({ theme, items, activeId, onPick, onDelete, onRename, onNew }: {
  theme: AgentTheme;
  items: Array<{ id: string; title: string; updatedAt: number; preview: string; state: string; messageCount: number }>;
  activeId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  onNew: () => void;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [q, setQ] = useState('');
  const shown = items.filter(c => c.messageCount > 0 || c.id === activeId)
    .filter(c => !q.trim() || `${c.title} ${c.preview}`.toLowerCase().includes(q.trim().toLowerCase()));

  const dayLabel = (t: number) => {
    const d = new Date(t); const now = new Date();
    const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((start(now) - start(d)) / 86_400_000);
    return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : diff < 7 ? 'This week' : 'Earlier';
  };
  let lastLabel = '';

  return (
    <div className="flex-1 overflow-y-auto overscroll-contain agent-scroll">
      <div className="p-2.5 space-y-2 sticky top-0 z-10" style={{ background: theme.bg }}>
        <div className="flex items-center gap-2 rounded-xl px-2.5 h-9" style={{ border: `1px solid ${theme.bdr}`, background: theme.surface }}>
          <Search size={13} style={{ color: theme.sub }} />
          <input value={q} onChange={e => setQ(e.target.value)} onKeyDown={e => e.stopPropagation()} placeholder="Search chats" className="flex-1 bg-transparent outline-none text-[12.5px]" style={{ color: theme.text }} />
        </div>
        <button type="button" onClick={onNew} className="w-full h-9 rounded-xl text-[12.5px] font-semibold flex items-center justify-center gap-1.5" style={{ background: `${theme.accent}1a`, color: theme.accent }}>
          <Plus size={14} /> New chat
        </button>
      </div>
      {!shown.length && <div className="text-center text-[12.5px] py-10" style={{ color: theme.sub }}>{q ? 'No chats match.' : 'No chats yet.'}</div>}
      <div className="px-2.5 pb-3 space-y-0.5">
        {shown.map(c => {
          const label = dayLabel(c.updatedAt);
          const head = label !== lastLabel ? label : null;
          lastLabel = label;
          return (
            <React.Fragment key={c.id}>
              {head && <div className="text-[10px] font-bold uppercase tracking-wider px-2 pt-3 pb-1" style={{ color: theme.sub }}>{head}</div>}
              <div className="rounded-2xl px-3 py-2.5 flex items-start gap-2 group transition-colors" style={{ background: c.id === activeId ? `${theme.accent}18` : undefined, boxShadow: c.id === activeId ? `inset 0 0 0 1px ${theme.accent}33` : undefined }}
                onMouseEnter={e => { if (c.id !== activeId) e.currentTarget.style.background = theme.hover; }}
                onMouseLeave={e => { if (c.id !== activeId) e.currentTarget.style.background = 'transparent'; }}
              >
                {editing === c.id ? (
                  <input
                    autoFocus
                    value={title}
                    onChange={e => setTitle(e.target.value)}
                    onKeyDown={e => {
                      e.stopPropagation();
                      if (e.key === 'Enter' && title.trim()) { onRename(c.id, title.trim()); setEditing(null); }
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    onBlur={() => setEditing(null)}
                    className="flex-1 rounded-lg px-2 py-1 text-[12.5px] outline-none"
                    style={{ border: `1px solid ${theme.accent}`, background: theme.bg, color: theme.text }}
                  />
                ) : (
                  <button type="button" onClick={() => onPick(c.id)} className="min-w-0 flex-1 text-left">
                    <div className="text-[12.5px] font-semibold truncate flex items-center gap-1.5" style={{ color: theme.text }} dir="auto">
                      {(c.state === 'awaiting_answer' || c.state === 'awaiting_approval') && <span className="inline-block rounded-full flex-shrink-0" style={{ width: 7, height: 7, background: '#f59e0b' }} title="Waiting for you" />}
                      {c.state === 'running' && <Loader2 size={11} className="animate-spin flex-shrink-0" />}
                      <span className="truncate">{c.title}</span>
                    </div>
                    <div className="text-[11px] truncate" style={{ color: theme.sub }} dir="auto">{c.preview || 'Empty chat'}</div>
                  </button>
                )}
                {confirming === c.id ? (
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button type="button" onClick={() => { onDelete(c.id); setConfirming(null); }} className="text-[11px] font-semibold px-2 py-1 rounded-md text-white" style={{ background: '#ef4444' }}>Delete</button>
                    <button type="button" onClick={() => setConfirming(null)} className="text-[11px] px-2 py-1 rounded-md" style={{ color: theme.sub }}>Cancel</button>
                  </div>
                ) : editing !== c.id && (
                  <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button type="button" onClick={() => { setEditing(c.id); setTitle(c.title); }} className="p-1 rounded-md" style={{ color: theme.sub }} title="Rename"><Pencil size={12} /></button>
                    <button type="button" onClick={() => setConfirming(c.id)} className="p-1 rounded-md" style={{ color: theme.sub }} title="Delete this chat (your calendar is not affected)"><Trash2 size={12} /></button>
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
