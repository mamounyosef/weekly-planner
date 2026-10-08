// ─── The planning assistant, on the phone ────────────────────────────────────
//
// A window onto the assistant that runs on the PC: the same conversations,
// the same live replies, the same ground-truth report of what changed. Input
// is as open as the phone allows: typing, speaking, photos from the gallery,
// the camera, an image copied to the clipboard, or anything shared to the app
// from another app's share menu.
//
// The report under each reply is built from change records the PC wrote after
// reading the saved data back, never from the model's own words, so what it
// says was added is what was added.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Image, KeyboardAvoidingView, Modal, Pressable, ScrollView, TextInput, View, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import * as Clipboard from 'expo-clipboard';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';

import { Text, useTheme } from '../ui/kit';
import { ICONS } from '../ui/icons';
import { AgentOrb } from '../ui/AgentOrb';
import { radius, space } from '../theme';
import type { Palette } from '../theme';
import {
  attachmentSource, uploadImage, usePhoneAgent, type LocalImage,
} from '../lib/agent/agentApi';
import type {
  AgentApproval, AgentAttachment, AgentConversation, AgentMessage, AgentQuestion, AgentQuestionAnswer, ChangeSet,
} from '../lib/agent/agentTypes';
import { AGENT_LIMITS } from '../lib/agent/agentTypes';
import { buildReport, summarize, type Tone } from '../lib/agent/agentReport';
import { PhoneImagePreviewModal, type PreviewItem } from './AssistantImagePreview';

export interface SharedToAssistant {
  /** Changes whenever something new is shared, so the same file twice still lands. */
  key: string;
  images: LocalImage[];
  text?: string;
}

interface PendingFile {
  localId: string;
  preview: string;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
  uploaded?: AgentAttachment;
}

let seq = 0;

/** The assistant's colour, the same sky blue as on the PC. */
const SKY = '#0ea5e9';

function greeting(): string {
  const h = new Date().getHours();
  return h < 5 ? 'Up late?' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

function Icon({ name, size = 20, color }: { name: string; size?: number; color: string }) {
  const src = ICONS[name];
  if (!src) return null;
  return <Image source={{ uri: src }} style={{ width: size, height: size, tintColor: color }} />;
}

function IconButton({ name, onPress, color, bg, disabled, size = 20, label }: {
  name: string; onPress: () => void; color: string; bg?: string; disabled?: boolean; size?: number; label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityLabel={label}
      hitSlop={6}
      style={({ pressed }) => ({
        width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
        backgroundColor: bg ?? 'transparent', opacity: disabled ? 0.4 : pressed ? 0.6 : 1,
      })}
    >
      <Icon name={name} size={size} color={color} />
    </Pressable>
  );
}

export function Assistant({ visible, onTab, timeFormat, shared, onSharedHandled, onOpenDate }: {
  visible: boolean;
  /** The assistant tab is selected; switching to it starts a fresh chat. */
  onTab?: boolean;
  timeFormat: '12h' | '24h';
  shared?: SharedToAssistant | null;
  onSharedHandled?: () => void;
  /** Show a day on the calendar tab (a report's day heading was tapped). */
  onOpenDate?: (date: string) => void;
}) {
  const p = useTheme();
  const insets = useSafeAreaInsets();
  const agent = usePhoneAgent(visible, onTab ?? visible);
  const conv = agent.conversation;
  const busy = conv?.state === 'running';

  const [draft, setDraft] = useState('');
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [previewState, setPreviewState] = useState<{
    items: PreviewItem[];
    index: number;
    isPending?: boolean;
  } | null>(null);
  const [sending, setSending] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [clipHasImage, setClipHasImage] = useState(false);
  const [listening, setListening] = useState(false);
  const baseDraftRef = useRef('');
  const scrollRef = useRef<ScrollView>(null);

  const removeFile = useCallback((localId: string) => {
    setFiles(f => f.filter(x => x.localId !== localId));
    setPreviewState(prev => {
      if (!prev || !prev.isPending) return prev;
      const nextItems = prev.items.filter(x => x.localId !== localId);
      if (nextItems.length === 0) return null;
      return { ...prev, items: nextItems, index: Math.min(prev.index, nextItems.length - 1) };
    });
  }, []);

  // ── Attachments ──
  const addImages = useCallback((imgs: LocalImage[]) => {
    for (const img of imgs.slice(0, AGENT_LIMITS.maxAttachments)) {
      const localId = `p${++seq}`;
      setFiles(f => (f.length >= AGENT_LIMITS.maxAttachments ? f : [...f, { localId, preview: img.uri, status: 'uploading' }]));
      uploadImage(img)
        .then(uploaded => setFiles(f => f.map(x => (x.localId === localId ? { ...x, status: 'ready', uploaded } : x))))
        .catch(err => setFiles(f => f.map(x => (x.localId === localId ? { ...x, status: 'error', error: String(err?.message ?? err) } : x))));
    }
  }, []);

  const pickFromGallery = useCallback(async () => {
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'], allowsMultipleSelection: true, selectionLimit: AGENT_LIMITS.maxAttachments, quality: 1,
    });
    if (res.canceled) return;
    addImages(res.assets.map(a => ({ uri: a.uri, width: a.width, height: a.height, name: a.fileName ?? undefined })));
  }, [addImages]);

  const takePhoto = useCallback(async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    if (!perm.granted) { agent.setError('Camera permission is needed to take a photo.'); return; }
    const res = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1 });
    if (res.canceled) return;
    addImages(res.assets.map(a => ({ uri: a.uri, width: a.width, height: a.height, name: a.fileName ?? 'photo.jpg' })));
  }, [addImages, agent]);

  const pasteImage = useCallback(async () => {
    try {
      const img = await Clipboard.getImageAsync({ format: 'jpeg', jpegQuality: 0.92 });
      if (!img) { agent.setError('There is no image on the clipboard.'); return; }
      addImages([{ uri: img.data, width: img.size.width, height: img.size.height, name: 'pasted-image.jpg' }]);
      setClipHasImage(false);
    } catch {
      agent.setError('Could not read the clipboard.');
    }
  }, [addImages, agent]);

  // Offer "paste image" only when there is one to paste.
  useEffect(() => {
    if (!visible) return;
    Clipboard.hasImageAsync().then(setClipHasImage).catch(() => setClipHasImage(false));
  }, [visible, files.length]);

  // Something shared to the app from another app.
  useEffect(() => {
    if (!shared) return;
    if (shared.images.length) addImages(shared.images);
    if (shared.text) setDraft(d => (d ? `${d}\n${shared.text}` : shared.text!));
    onSharedHandled?.();
  }, [shared, addImages, onSharedHandled]);

  // ── Voice ──
  useSpeechRecognitionEvent('result', (ev) => {
    const t = ev.results?.[0]?.transcript ?? '';
    setDraft(baseDraftRef.current + t);
    if (ev.isFinal) baseDraftRef.current = `${baseDraftRef.current}${t} `;
  });
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('error', (ev) => {
    setListening(false);
    if (ev.error !== 'no-speech' && ev.error !== 'aborted') agent.setError(`Voice input: ${ev.message || ev.error}`);
  });

  const toggleMic = useCallback(async () => {
    if (listening) { ExpoSpeechRecognitionModule.stop(); return; }
    const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!perm.granted) { agent.setError('Microphone permission is needed for voice input.'); return; }
    baseDraftRef.current = draft ? `${draft.replace(/\s+$/, '')} ` : '';
    // Voice language follows what is already typed (Arabic script means Arabic),
    // otherwise the phone's own language. Replies follow whatever you write.
    const lang = /[؀-ۿ]/.test(draft) ? 'ar-JO' : undefined;
    ExpoSpeechRecognitionModule.start({ ...(lang ? { lang } : {}), interimResults: true, continuous: true });
    setListening(true);
  }, [listening, draft, agent]);

  // ── Sending ──
  const uploading = files.some(f => f.status === 'uploading');
  const ready = files.filter(f => f.status === 'ready');
  const canSend = !sending && !uploading && (draft.trim().length > 0 || ready.length > 0);

  const send = useCallback(async () => {
    if (!canSend) return;
    if (listening) ExpoSpeechRecognitionModule.stop();
    setSending(true);
    agent.setError(null);
    try {
      await agent.send(draft.trim(), ready.map(f => f.uploaded!.id));
      setDraft('');
      baseDraftRef.current = '';
      setFiles([]);
    } catch (err: any) {
      agent.setError(err?.message ?? 'Could not send.');
    } finally {
      setSending(false);
    }
  }, [canSend, listening, agent, draft, ready]);

  useEffect(() => {
    const t = setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 60);
    return () => clearTimeout(t);
  }, [conv?.messages.length, conv?.state, agent.liveText.length > 0]);

  const lastAssistantId = useMemo(() => [...(conv?.messages ?? [])].reverse().find(m => m.role === 'assistant')?.id, [conv]);

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: p.bg }}>
      {/* Header */}
      <View style={{
        paddingTop: insets.top + space.sm, paddingHorizontal: space.lg, paddingBottom: space.sm,
        flexDirection: 'row', alignItems: 'center', gap: space.sm, borderBottomWidth: 1, borderBottomColor: p.line,
      }}>
        <AgentOrb size={30} busy={busy} />
        <Pressable style={{ flex: 1 }} onPress={() => setShowHistory(v => !v)}>
          <Text variant="heading" numberOfLines={1}>{conv?.title ?? 'Assistant'}</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: agent.online ? p.ok : p.warn }} />
            <Text variant="caption" tone="faint">
              {agent.status?.configured === false ? 'Not set up on the PC' : busy ? 'Working...' : agent.online ? 'Gemma 4, running on your PC' : 'Cannot reach the PC'}
            </Text>
          </View>
        </Pressable>
        <IconButton name="plus" label="New chat" color={p.ink} bg={p.surfaceAlt} onPress={() => { setShowHistory(false); agent.newChat().catch(e => agent.setError(e.message)); }} />
        <IconButton name="history" label="Your chats" color={showHistory ? p.accent : p.ink} bg={p.surfaceAlt} onPress={() => setShowHistory(v => !v)} />
      </View>

      {showHistory ? (
        <History p={p} list={agent.list} activeId={agent.activeId} onPick={id => { agent.select(id); setShowHistory(false); }} onDelete={id => agent.remove(id).catch(e => agent.setError(e.message))} />
      ) : (
        <ScrollView
          ref={scrollRef}
          style={{ flex: 1 }}
          contentContainerStyle={{ padding: space.lg, gap: space.lg, paddingBottom: space.xl }}
          keyboardShouldPersistTaps="handled"
        >
          {!conv?.messages.length && <EmptyState p={p} onPick={t => setDraft(t)} />}
          {conv?.messages.map(m => (m.role === 'user'
            ? <UserBubble key={m.id} m={m} p={p} onPreview={(items, index) => setPreviewState({ items, index, isPending: false })} />
            : (
              <AssistantBlock
                key={m.id}
                m={m}
                conv={conv}
                p={p}
                isLast={m.id === lastAssistantId}
                liveText={m.id === lastAssistantId && busy ? agent.liveText : ''}
                liveThinking={m.id === lastAssistantId && busy ? agent.liveThinking : ''}
                timeFormat={timeFormat}
                onAnswer={a => agent.answer(a)}
                onDecide={yes => agent.decide(yes)}
                onUndo={ids => agent.undo(ids)}
                onOpenDate={onOpenDate}
              />
            )))}
          {agent.error ? <Note p={p} text={agent.error} /> : null}
        </ScrollView>
      )}

      {/* Composer */}
      {!showHistory && (
        <View style={{ margin: space.sm, marginTop: 0, borderRadius: 22, borderWidth: 1, borderColor: listening ? p.danger : p.line, backgroundColor: p.surface, paddingHorizontal: space.sm, paddingTop: space.sm, paddingBottom: 4, elevation: 6 }}>
          {files.length > 0 && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingBottom: space.sm }}>
              {files.map((f, idx) => (
                <View key={f.localId} style={{ width: 64, height: 64, borderRadius: radius.sm, overflow: 'hidden', borderWidth: 1, borderColor: f.status === 'error' ? p.danger : p.line }}>
                  <Pressable
                    onPress={() => setPreviewState({
                      items: files.map(x => ({ uri: x.preview, localId: x.localId, name: 'Attachment' })),
                      index: idx,
                      isPending: true,
                    })}
                    style={{ width: '100%', height: '100%' }}
                    accessibilityLabel="Preview image"
                  >
                    <Image source={{ uri: f.preview }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                  </Pressable>
                  {f.status === 'uploading' && (
                    <View style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
                      <ActivityIndicator color="#fff" />
                    </View>
                  )}
                  {f.status === 'ready' && (
                    <View style={{ position: 'absolute', bottom: 2, left: 2, width: 14, height: 14, borderRadius: 7, backgroundColor: '#22c55e', alignItems: 'center', justifyContent: 'center' }} pointerEvents="none">
                      <Icon name="check" size={9} color="#fff" />
                    </View>
                  )}
                  <Pressable
                    onPress={() => removeFile(f.localId)}
                    hitSlop={8}
                    style={{ position: 'absolute', top: 2, right: 2, width: 20, height: 20, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center' }}
                  >
                    <Icon name="x" size={12} color="#fff" />
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: space.xs }}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={listening ? 'Listening...' : conv?.state === 'awaiting_answer' ? 'Answer above, or type a reply' : 'Ask, or share a screenshot'}
              placeholderTextColor={p.inkFaint}
              multiline
              style={{
                flex: 1, minHeight: 44, maxHeight: 150, color: p.ink, fontSize: 15,
                backgroundColor: 'transparent', borderRadius: radius.md, borderWidth: 0,
                paddingHorizontal: space.md, paddingTop: 11, paddingBottom: 11, textAlignVertical: 'top',
              }}
            />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 2 }}>
            <IconButton name="image" label="Pick photos" color={p.inkSoft} onPress={() => pickFromGallery().catch(e => agent.setError(String(e?.message ?? e)))} />
            <IconButton name="camera" label="Take a photo" color={p.inkSoft} onPress={() => takePhoto().catch(e => agent.setError(String(e?.message ?? e)))} />
            {clipHasImage && <IconButton name="clipboard-paste" label="Paste image" color={p.accent} onPress={pasteImage} />}
            <IconButton name="mic" label={listening ? 'Stop listening' : 'Speak'} color={listening ? p.danger : p.inkSoft} bg={listening ? p.warnSoft : undefined} onPress={() => toggleMic().catch(e => agent.setError(String(e?.message ?? e)))} />
            <View style={{ flex: 1 }} />
            {busy ? (
              <Pressable onPress={agent.stop} accessibilityLabel="Stop" style={{ width: 38, height: 38, borderRadius: 19, backgroundColor: p.ink, alignItems: 'center', justifyContent: 'center' }}>
                <View style={{ width: 12, height: 12, borderRadius: 3, backgroundColor: p.bg }} />
              </Pressable>
            ) : (
              <Pressable
                onPress={send}
                disabled={!canSend}
                accessibilityLabel="Send"
                style={({ pressed }) => ({
                  width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center',
                  backgroundColor: canSend ? SKY : p.surfaceAlt, transform: [{ scale: pressed ? 0.92 : 1 }],
                })}
              >
                {sending || uploading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Icon name="arrow-up" size={20} color={canSend ? '#ffffff' : p.inkFaint} />}
              </Pressable>
            )}
          </View>
        </View>
      )}

      {previewState && (
        <PhoneImagePreviewModal
          visible={!!previewState}
          items={previewState.items}
          initialIndex={previewState.index}
          onClose={() => setPreviewState(null)}
          onRemove={previewState.isPending ? removeFile : undefined}
          p={p}
        />
      )}
    </KeyboardAvoidingView>
  );
}

// ─── Pieces ──────────────────────────────────────────────────────────────────

const EXAMPLES = [
  { icon: 'image', title: 'From a screenshot', text: 'Add the schedule in this screenshot to my calendar' },
  { icon: 'history', title: 'My day', text: 'What do I have tomorrow?' },
  { icon: 'pencil', title: 'Change something', text: 'Move my gym session today to 8 PM' },
  { icon: 'check', title: 'Plan for me', text: 'Find 2 free hours on Friday to study and book them' },
];

function EmptyState({ p, onPick }: { p: Palette; onPick: (t: string) => void }) {
  return (
    <View style={{ gap: space.lg, paddingTop: space.xl }}>
      <View style={{ alignItems: 'center', gap: space.sm }}>
        <AgentOrb size={52} />
        <Text variant="title">{greeting()}</Text>
        <Text variant="heading" tone="soft">What should we plan?</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
        {EXAMPLES.map(ex => (
          <Pressable
            key={ex.text}
            onPress={() => onPick(ex.text)}
            style={({ pressed }) => ({
              width: '48.5%', borderWidth: 1, borderColor: p.line, borderRadius: radius.lg, padding: space.md, gap: 6,
              backgroundColor: p.surface, opacity: pressed ? 0.7 : 1,
            })}
          >
            <View style={{ width: 30, height: 30, borderRadius: 9, backgroundColor: p.accentSoft, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={ex.icon} size={15} color={p.accent} />
            </View>
            <Text variant="caption" style={{ fontWeight: '700' }}>{ex.title}</Text>
            <Text variant="caption" tone="soft">{ex.text}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function AuthedImage({ id, style }: { id: string; style: object }) {
  const [src, setSrc] = useState<{ uri: string; headers: Record<string, string> } | null>(null);
  useEffect(() => { attachmentSource(id).then(setSrc).catch(() => {}); }, [id]);
  if (!src) return <View style={style} />;
  return <Image source={src} style={style} resizeMode="cover" />;
}

function UserBubble({
  m,
  p,
  onPreview,
}: {
  m: AgentMessage;
  p: Palette;
  onPreview?: (items: PreviewItem[], index: number) => void;
}) {
  const imageAttachments = useMemo(() => (m.attachments ?? []).filter(a => a.kind === 'image'), [m.attachments]);

  return (
    <View style={{ alignItems: 'flex-end', gap: space.xs }}>
      {m.attachments?.length ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.xs, maxWidth: '88%' }}>
          {m.attachments.map(a => (a.kind === 'image'
            ? (
              <Pressable
                key={a.id}
                onPress={() => {
                  const idx = imageAttachments.findIndex(x => x.id === a.id);
                  onPreview?.(
                    imageAttachments.map(x => ({ id: x.id, name: x.name })),
                    Math.max(0, idx)
                  );
                }}
                accessibilityLabel={`Preview ${a.name}`}
                style={({ pressed }) => ({
                  borderRadius: radius.sm,
                  overflow: 'hidden',
                  opacity: pressed ? 0.8 : 1,
                })}
              >
                <AuthedImage id={a.id} style={{ width: 120, height: 120, borderRadius: radius.sm, backgroundColor: p.surfaceAlt }} />
              </Pressable>
            )
            : <View key={a.id} style={{ padding: space.sm, borderRadius: radius.sm, borderWidth: 1, borderColor: p.line }}><Text variant="caption" tone="soft">{a.name}</Text></View>))}
        </View>
      ) : null}
      {m.text ? (
        <View style={{ maxWidth: '85%', backgroundColor: p.surfaceAlt, borderRadius: 20, paddingHorizontal: space.lg, paddingVertical: 10 }}>
          <Text variant="body">{m.text}</Text>
        </View>
      ) : null}
    </View>
  );
}

/** Bold, bullets and numbered lines: all a reply needs, nothing that can inject. */
function Markdown({ text, p }: { text: string; p: Palette }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const inline = (s: string, key: string) => s.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (
    part.startsWith('**') && part.endsWith('**')
      ? <Text key={`${key}-${i}`} variant="bodyStrong">{part.slice(2, -2)}</Text>
      : part.replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2')
  ));
  return (
    <View style={{ gap: 4 }}>
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <View key={i} style={{ height: 4 }} />;
        const h = /^\s*#{1,6}\s+(.*)$/.exec(line);
        if (h) return <Text key={i} variant="bodyStrong">{h[1].replace(/\*\*/g, '')}</Text>;
        const b = /^\s*[-*•]\s+(.*)$/.exec(line) ?? /^\s*(\d+[.)])\s+(.*)$/.exec(line);
        if (b) {
          const numbered = b.length === 3;
          return (
            <View key={i} style={{ flexDirection: 'row', gap: 6, paddingLeft: 4 }}>
              <Text variant="body" tone="soft">{numbered ? b[1] : '•'}</Text>
              <Text variant="body" style={{ flex: 1 }}>{inline(numbered ? b[2] : b[1], `l${i}`)}</Text>
            </View>
          );
        }
        return <Text key={i} variant="body">{inline(line, `p${i}`)}</Text>;
      })}
    </View>
  );
}

function Collapsible({ label, children, p }: { label: string; children: React.ReactNode; p: Palette }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(v => !v)} style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} color={p.inkFaint} />
        <Text variant="caption" tone="faint">{label}</Text>
      </Pressable>
      {open ? <View style={{ paddingLeft: 18, paddingTop: 4 }}>{children}</View> : null}
    </View>
  );
}

function AssistantBlock({ m, conv, p, isLast, liveText, liveThinking, timeFormat, onAnswer, onDecide, onUndo, onOpenDate }: {
  m: AgentMessage; conv: AgentConversation; p: Palette; isLast: boolean; liveText: string; liveThinking: string;
  timeFormat: '12h' | '24h';
  onAnswer: (a: AgentQuestionAnswer[]) => Promise<void>;
  onDecide: (yes: boolean) => Promise<void>;
  onUndo: (ids: string[]) => Promise<void>;
  onOpenDate?: (date: string) => void;
}) {
  const sets = (m.changeSetIds ?? []).map(id => conv.changeSets[id]).filter(Boolean) as ChangeSet[];
  const running = isLast && conv.state === 'running';
  const text = [m.text, liveText].filter(Boolean).join('\n\n');
  const thinking = [m.thinking, liveThinking].filter(Boolean).join('\n\n');
  const tools = m.tools ?? [];
  const runningTool = tools.find(t => t.status === 'running');

  return (
    <View>
      <View style={{ gap: space.sm, minWidth: 0 }}>
      {thinking ? (
        <Collapsible p={p} label={running && !liveText ? 'Thinking...' : 'Reasoning'}>
          <Text variant="caption" tone="soft">{thinking}</Text>
        </Collapsible>
      ) : null}
      {tools.length ? (
        <Collapsible p={p} label={`${tools.length} step${tools.length === 1 ? '' : 's'}`}>
          {tools.map(t => (
            <Text key={t.id} variant="caption" tone={t.status === 'ok' ? 'soft' : t.status === 'running' ? 'accent' : 'warn'}>
              {t.status === 'running' ? '... ' : ''}{t.label}
            </Text>
          ))}
        </Collapsible>
      ) : null}
      {runningTool ? (
        <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
          <ActivityIndicator size="small" color={p.accent} />
          <Text variant="caption" tone="soft">{runningTool.label}</Text>
        </View>
      ) : null}
      {text ? <Markdown text={text} p={p} /> : null}
      {running && !text && !runningTool ? (
        <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
          <AgentOrb size={16} busy />
          <Text variant="caption" tone="soft">Reading your request...</Text>
        </View>
      ) : null}
      {m.questions ? (
        <QuestionCard p={p} questions={m.questions} answers={m.answers} active={isLast && conv.state === 'awaiting_answer' && !m.answers} onSubmit={onAnswer} />
      ) : null}
      {m.approval ? (
        <ApprovalCard p={p} approval={m.approval} decision={m.approvalDecision} active={isLast && conv.state === 'awaiting_approval'} onDecide={onDecide} />
      ) : null}
      {sets.length ? <ReportCard p={p} sets={sets} timeFormat={timeFormat} onUndo={onUndo} onOpenDate={onOpenDate} /> : null}
      {m.error ? <Note p={p} text={m.error} /> : null}
      </View>
    </View>
  );
}

function Note({ p, text }: { p: Palette; text: string }) {
  return (
    <View style={{ borderRadius: radius.md, backgroundColor: p.warnSoft, padding: space.md }}>
      <Text variant="caption" tone="warn">{text}</Text>
    </View>
  );
}

function CardShell({ p, title, color, children }: { p: Palette; title: string; color: string; children: React.ReactNode }) {
  return (
    <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: color, backgroundColor: p.surface, overflow: 'hidden' }}>
      <View style={{ paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: p.line }}>
        <Text variant="bodyStrong" style={{ color }}>{title}</Text>
      </View>
      <View style={{ padding: space.md, gap: space.md }}>{children}</View>
    </View>
  );
}

function QuestionCard({ p, questions, answers, active, onSubmit }: {
  p: Palette; questions: AgentQuestion[]; answers?: AgentQuestionAnswer[]; active: boolean;
  onSubmit: (a: AgentQuestionAnswer[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (answers && !active) {
    return (
      <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: p.line, padding: space.md, gap: space.sm }}>
        {questions.map(q => {
          const a = answers.find(x => x.questionId === q.id);
          const parts = [...(a?.selected ?? []), ...(a?.other ? [a.other] : [])];
          return (
            <View key={q.id}>
              <Text variant="caption" tone="soft">{q.question}</Text>
              <Text variant="bodyStrong">{parts.length ? parts.join(', ') : 'No answer'}</Text>
            </View>
          );
        })}
      </View>
    );
  }

  const complete = questions.every(q => (picked[q.id]?.length ?? 0) > 0 || (other[q.id] ?? '').trim());
  const toggle = (q: AgentQuestion, label: string) => setPicked(s => {
    const cur = s[q.id] ?? [];
    if (q.multiSelect) return { ...s, [q.id]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] };
    return { ...s, [q.id]: cur[0] === label ? [] : [label] };
  });

  const submit = async () => {
    setBusy(true); setErr(null);
    try {
      await onSubmit(questions.map(q => ({
        questionId: q.id,
        selected: q.options.map(o => o.label).filter(l => (picked[q.id] ?? []).includes(l)),
        ...((other[q.id] ?? '').trim() ? { other: other[q.id].trim() } : {}),
      })));
    } catch (e: any) { setErr(e?.message ?? 'Could not send.'); setBusy(false); }
  };

  return (
    <CardShell p={p} color={p.accent} title={questions.length === 1 ? 'A quick question' : `${questions.length} quick questions`}>
      {questions.map(q => (
        <View key={q.id} style={{ gap: space.sm }}>
          <Text variant="bodyStrong">{q.question}</Text>
          {q.options.map(o => {
            const on = (picked[q.id] ?? []).includes(o.label);
            return (
              <Pressable
                key={o.label}
                disabled={busy}
                onPress={() => toggle(q, o.label)}
                style={{ borderRadius: radius.sm, borderWidth: 1, borderColor: on ? p.accent : p.line, backgroundColor: on ? p.accentSoft : 'transparent', padding: space.md, flexDirection: 'row', gap: space.sm }}
              >
                <View style={{ width: 18, height: 18, marginTop: 1, borderRadius: q.multiSelect ? 4 : 9, borderWidth: 2, borderColor: on ? p.accent : p.inkFaint, backgroundColor: on ? p.accent : 'transparent', alignItems: 'center', justifyContent: 'center' }}>
                  {on ? <Icon name="check" size={12} color={p.accentInk} /> : null}
                </View>
                <View style={{ flex: 1 }}>
                  <Text variant="bodyStrong">{o.label}</Text>
                  {o.description ? <Text variant="caption" tone="soft">{o.description}</Text> : null}
                </View>
              </Pressable>
            );
          })}
          <TextInput
            value={other[q.id] ?? ''}
            onChangeText={v => setOther(s => ({ ...s, [q.id]: v }))}
            placeholder="Other (type your own answer)"
            placeholderTextColor={p.inkFaint}
            editable={!busy}
            style={{ borderRadius: radius.sm, borderWidth: 1, borderColor: p.line, color: p.ink, paddingHorizontal: space.md, paddingVertical: 10, fontSize: 15 }}
          />
        </View>
      ))}
      {err ? <Text variant="caption" tone="danger">{err}</Text> : null}
      <Pressable disabled={!complete || busy} onPress={submit} style={{ borderRadius: radius.pill, backgroundColor: p.accent, alignItems: 'center', justifyContent: 'center', height: 46, opacity: !complete || busy ? 0.5 : 1 }}>
        {busy ? <ActivityIndicator color={p.accentInk} /> : <Text variant="bodyStrong" style={{ color: p.accentInk }}>Send answer</Text>}
      </Pressable>
    </CardShell>
  );
}

function ApprovalCard({ p, approval, decision, active, onDecide }: {
  p: Palette; approval: AgentApproval; decision?: { approved: boolean; note?: string }; active: boolean;
  onDecide: (yes: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState<null | boolean>(null);
  const [err, setErr] = useState<string | null>(null);
  const n = approval.deletions.length;
  const go = async (yes: boolean) => {
    setBusy(yes); setErr(null);
    try { await onDecide(yes); } catch (e: any) { setErr(e?.message ?? 'Could not send.'); setBusy(null); }
  };
  const title = decision
    ? (decision.approved ? `Approved: delete ${n} item${n === 1 ? '' : 's'}` : 'Not deleted')
    : `Delete ${n} item${n === 1 ? '' : 's'}? Your approval is needed`;
  return (
    <CardShell p={p} color={p.danger} title={title}>
      <Text variant="body">{approval.reason}</Text>
      {approval.deletions.map(d => (
        <View key={`${d.id}-${d.scopeLabel}`} style={{ gap: 2 }}>
          <Text variant="bodyStrong">{d.title}</Text>
          <Text variant="caption" tone="soft">{d.when}{d.repeats ? `  ·  ${d.repeats}` : ''}</Text>
          <Text variant="caption" tone="danger">{d.scopeLabel}</Text>
        </View>
      ))}
      {err ? <Text variant="caption" tone="danger">{err}</Text> : null}
      {!decision && active ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <Pressable disabled={busy !== null} onPress={() => go(true)} style={{ flex: 1, height: 46, borderRadius: radius.pill, backgroundColor: p.danger, alignItems: 'center', justifyContent: 'center', opacity: busy !== null ? 0.6 : 1 }}>
            {busy === true ? <ActivityIndicator color="#fff" /> : <Text variant="bodyStrong" style={{ color: '#fff' }}>Delete</Text>}
          </Pressable>
          <Pressable disabled={busy !== null} onPress={() => go(false)} style={{ flex: 1, height: 46, borderRadius: radius.pill, borderWidth: 1, borderColor: p.line, alignItems: 'center', justifyContent: 'center', opacity: busy !== null ? 0.6 : 1 }}>
            {busy === false ? <ActivityIndicator color={p.ink} /> : <Text variant="bodyStrong">Keep them</Text>}
          </Pressable>
        </View>
      ) : null}
      {decision ? (
        <Text variant="caption" tone={decision.approved ? 'danger' : 'soft'}>
          {decision.approved ? 'You approved this. The result is listed below.' : (decision.note ?? 'You chose to keep them. Nothing was deleted.')}
        </Text>
      ) : null}
    </CardShell>
  );
}

function toneColors(tone: Tone, p: Palette): { bg: string; fg: string } {
  switch (tone) {
    case 'added': return { bg: 'rgba(34,197,94,0.18)', fg: p.ok };
    case 'updated': return { bg: p.accentSoft, fg: p.accent };
    case 'deleted': return { bg: 'rgba(239,68,68,0.18)', fg: p.danger };
    case 'done': return { bg: 'rgba(139,92,246,0.2)', fg: '#a78bfa' };
    case 'failed': return { bg: p.warnSoft, fg: p.warn };
    default: return { bg: p.surfaceAlt, fg: p.inkSoft };
  }
}

const STATS: Array<{ action: 'added' | 'updated' | 'completed' | 'reopened' | 'deleted' | 'skipped' | 'failed'; label: string; tone: Tone }> = [
  { action: 'added', label: 'added', tone: 'added' },
  { action: 'updated', label: 'changed', tone: 'updated' },
  { action: 'completed', label: 'ticked', tone: 'done' },
  { action: 'reopened', label: 'un-ticked', tone: 'updated' },
  { action: 'deleted', label: 'deleted', tone: 'deleted' },
  { action: 'skipped', label: 'already there', tone: 'skipped' },
  { action: 'failed', label: 'not done', tone: 'failed' },
];

function ReportCard({ p, sets, timeFormat, onUndo, onOpenDate }: {
  p: Palette; sets: ChangeSet[]; timeFormat: '12h' | '24h'; onUndo: (ids: string[]) => Promise<void>;
  onOpenDate?: (date: string) => void;
}) {
  const groups = useMemo(() => buildReport(sets, timeFormat), [sets, timeFormat]);
  const summary = useMemo(() => summarize(sets), [sets]);
  const [undoing, setUndoing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const total = sets.reduce((n, s) => n + s.entries.length, 0);
  const [expanded, setExpanded] = useState(total <= 12);
  const undoable = sets.filter(s => !s.undoneAt && s.entries.some(e => e.action !== 'skipped' && e.action !== 'failed'));
  const onlyNoop = sets.every(s => s.entries.every(e => e.action === 'skipped' || e.action === 'failed'));
  const allUndone = !onlyNoop && undoable.length === 0 && sets.some(s => s.undoneAt);
  const notes = sets.map(s => s.undoNote).filter(Boolean) as string[];
  let shown = 0;

  return (
    <View style={{ borderRadius: radius.lg, borderWidth: 1, borderColor: p.line, backgroundColor: p.surface, overflow: 'hidden', elevation: 2 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, paddingHorizontal: space.md, paddingVertical: space.sm, borderBottomWidth: 1, borderBottomColor: p.line }}>
        <View style={{ width: 28, height: 28, borderRadius: 8, backgroundColor: allUndone || onlyNoop ? p.surfaceAlt : 'rgba(34,197,94,0.18)', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={allUndone ? 'undo-2' : 'check'} size={15} color={allUndone || onlyNoop ? p.inkSoft : p.ok} />
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="bodyStrong">{allUndone ? 'Undone' : 'What changed'}</Text>
          <Text variant="caption" tone="faint">{summary.unverified ? `${summary.unverified} not confirmed on disk` : 'Verified against your saved planner'}</Text>
        </View>
      </View>

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, paddingHorizontal: space.md, paddingTop: space.md }}>
        {STATS.filter(s => summary.counts[s.action]).map(s => {
          const c = toneColors(s.tone, p);
          return (
            <View key={s.action} style={{ backgroundColor: c.bg, borderRadius: 8, paddingHorizontal: 8, paddingVertical: 4 }}>
              <Text variant="caption" style={{ color: c.fg, fontWeight: '700' }}>{summary.counts[s.action]} {s.label}</Text>
            </View>
          );
        })}
      </View>

      {summary.unverified > 0 ? (
        <View style={{ margin: space.md, marginBottom: 0, padding: space.sm, borderRadius: radius.sm, backgroundColor: p.warnSoft }}>
          <Text variant="caption" tone="warn">{summary.unverified === 1 ? 'One item' : `${summary.unverified} items`} could not be read back right after saving. Check the calendar.</Text>
        </View>
      ) : null}

      <View style={{ padding: space.md, gap: space.md }}>
        {groups.map(g => {
          if (!expanded && shown >= 6) return null;
          return (
            <View key={g.heading} style={{ gap: 6 }}>
              <Pressable disabled={!g.date || !onOpenDate} onPress={() => g.date && onOpenDate?.(g.date)} hitSlop={6} style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text variant="label" tone="faint">{g.heading}</Text>
                {g.date && onOpenDate ? <Icon name="chevron-right" size={12} color={p.inkFaint} /> : null}
              </Pressable>
              <View style={{ borderRadius: radius.md, borderWidth: 1, borderColor: p.line, overflow: 'hidden' }}>
                {g.rows.map((r, ri) => {
                  if (!expanded && shown >= 6) return null;
                  shown++;
                  const c = toneColors(r.tone, p);
                  const struck = r.entry.action === 'deleted';
                  const bar = r.facts?.color && r.facts.color.startsWith('#') ? r.facts.color : c.fg;
                  const [from, to] = r.time.split(' to ');
                  return (
                    <View key={r.key} style={{ flexDirection: 'row', gap: space.sm, padding: space.sm, borderTopWidth: ri ? 1 : 0, borderTopColor: p.line, opacity: r.entry.action === 'skipped' ? 0.75 : 1 }}>
                      <View style={{ width: 4, borderRadius: 2, backgroundColor: bar, opacity: struck ? 0.35 : 0.9 }} />
                      <View style={{ width: 66 }}>
                        <Text variant="caption" style={{ fontWeight: '700' }}>
                          {r.facts?.allDay ? 'All day' : r.facts?.startTime ? from : r.facts?.kind === 'task' ? 'Task' : ''}
                        </Text>
                        {r.facts?.endTime && !r.facts.allDay && to ? <Text variant="caption" tone="faint">{to}</Text> : null}
                      </View>
                      <View style={{ flex: 1, gap: 3 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 6 }}>
                          <Text variant="bodyStrong" style={[{ flex: 1 }, struck ? { textDecorationLine: 'line-through', opacity: 0.7 } : null]}>{r.facts?.title}</Text>
                          <View style={{ backgroundColor: c.bg, borderRadius: 6, paddingHorizontal: 5, paddingVertical: 1 }}>
                            <Text variant="caption" style={{ color: c.fg, fontWeight: '700', fontSize: 10 }}>{r.word.toUpperCase()}</Text>
                          </View>
                        </View>
                        {r.chips.length || !r.entry.verified ? (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                            {r.chips.map(ch => (
                              <View key={ch.label} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: p.surfaceAlt, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                                {ch.color ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: ch.color }} /> : null}
                                <Text variant="caption" tone="soft" style={{ fontSize: 11 }}>{ch.label}</Text>
                              </View>
                            ))}
                            {!r.entry.verified ? (
                              <View style={{ backgroundColor: p.warnSoft, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 2 }}>
                                <Text variant="caption" tone="warn" style={{ fontSize: 11 }}>not confirmed</Text>
                              </View>
                            ) : null}
                          </View>
                        ) : null}
                        {r.diffs.map(d => (
                          <Text key={d.field} variant="caption" tone="soft">
                            {`${d.label}  `}
                            <Text variant="caption" tone="faint" style={{ textDecorationLine: 'line-through' }}>{d.before}</Text>
                            {'  →  '}
                            <Text variant="caption" style={{ fontWeight: '700' }}>{d.after}</Text>
                          </Text>
                        ))}
                        {r.entry.note ? <Text variant="caption" tone="faint">{r.entry.note}</Text> : null}
                      </View>
                    </View>
                  );
                })}
              </View>
            </View>
          );
        })}
        {!expanded ? (
          <Pressable onPress={() => setExpanded(true)} style={{ borderRadius: radius.sm, backgroundColor: p.accentSoft, paddingVertical: 8, alignItems: 'center' }}>
            <Text variant="caption" tone="accent" style={{ fontWeight: '700' }}>Show all {total} changes</Text>
          </Pressable>
        ) : null}
      </View>

      {(undoable.length > 0 || allUndone || err || notes.length > 0) ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: space.md, gap: space.sm, borderTopWidth: 1, borderTopColor: p.line }}>
          <Text variant="caption" tone={err ? 'danger' : 'faint'} style={{ flex: 1 }}>
            {err ?? (allUndone || notes.length ? ['Undone.', ...notes].join(' ') : 'Not what you wanted?')}
          </Text>
          {undoable.length > 0 ? (
            <Pressable
              disabled={undoing}
              onPress={async () => {
                setUndoing(true); setErr(null);
                try { await onUndo(undoable.map(s => s.id).reverse()); } catch (e: any) { setErr(e?.message ?? 'Undo failed.'); }
                setUndoing(false);
              }}
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderColor: p.line, backgroundColor: p.surfaceAlt, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 7 }}
            >
              {undoing ? <ActivityIndicator size="small" color={p.ink} /> : <Icon name="undo-2" size={14} color={p.ink} />}
              <Text variant="bodyStrong">{total > 1 ? 'Undo all' : 'Undo'}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function History({ p, list, activeId, onPick, onDelete }: {
  p: Palette;
  list: Array<{ id: string; title: string; updatedAt: number; preview: string; state: string }>;
  activeId: string | null;
  onPick: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<string | null>(null);
  if (!list.length) {
    return <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}><Text variant="body" tone="soft">No chats yet.</Text></View>;
  }
  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: space.md, gap: space.xs }}>
      {list.map(c => (
        <View key={c.id} style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, borderRadius: radius.md, padding: space.md, backgroundColor: c.id === activeId ? p.accentSoft : 'transparent' }}>
          <Pressable style={{ flex: 1 }} onPress={() => onPick(c.id)}>
            <Text variant="bodyStrong" numberOfLines={1}>
              {c.state === 'awaiting_answer' || c.state === 'awaiting_approval' ? '● ' : ''}{c.title}
            </Text>
            <Text variant="caption" tone="soft" numberOfLines={1}>{c.preview || 'Empty chat'}</Text>
            <Text variant="caption" tone="faint">{new Date(c.updatedAt).toLocaleString()}</Text>
          </Pressable>
          {confirm === c.id ? (
            <Pressable onPress={() => { onDelete(c.id); setConfirm(null); }} style={{ backgroundColor: p.danger, borderRadius: radius.pill, paddingHorizontal: space.md, paddingVertical: 6 }}>
              <Text variant="caption" style={{ color: '#fff', fontWeight: '700' }}>Delete chat</Text>
            </Pressable>
          ) : (
            <IconButton name="trash-2" label="Delete chat" color={p.inkFaint} onPress={() => setConfirm(c.id)} size={18} />
          )}
        </View>
      ))}
    </ScrollView>
  );
}
