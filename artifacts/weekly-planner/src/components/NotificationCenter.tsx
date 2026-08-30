import { useEffect, useMemo, useState } from 'react';
import {
  AlarmClock,
  AlertTriangle,
  Bell,
  BellRing,
  Calendar,
  Check,
  CheckCheck,
  ChevronRight,
  Clock,
  ExternalLink,
  Inbox,
  ListChecks,
  Moon,
  Trash2,
  X,
} from 'lucide-react';
import type { NotificationKind, NotificationRecord } from '@/lib/notifications';
import type { NotifyTheme } from './NotifyEditor';

// ─── The notification centre ─────────────────────────────────────────────────
//
// A bell in the header, a slide-over panel, and the in-app banner. All three
// read the same server-owned store, so what is shown here is exactly what the
// phone shows, and dealing with something in one place clears it everywhere.

/** A mosque for a prayer, a calendar for an event: kind is legible at a glance. */
const KIND_ART: Record<NotificationKind, { icon: typeof Bell; color: string; label: string }> = {
  event: { icon: Calendar, color: '#3b82f6', label: 'Event' },
  task: { icon: Check, color: '#22c55e', label: 'Task' },
  'task-digest': { icon: ListChecks, color: '#f59e0b', label: 'Tasks' },
  prayer: { icon: MosqueIcon as unknown as typeof Bell, color: '#10b981', label: 'Prayer' },
};

/**
 * Lucide has no mosque, and the notification artwork uses one, so the panel
 * draws its own rather than showing a different symbol for the same thing.
 */
function MosqueIcon({ size = 16, ...rest }: { size?: number } & React.SVGProps<SVGSVGElement>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" {...rest}>
      <path d="M12 3.2v1.4" />
      <circle cx="12" cy="2.4" r="0.9" fill="currentColor" stroke="none" />
      <path d="M8 12a4 4 0 0 1 8 0" />
      <path d="M8 12v7h8v-7" />
      <path d="M10.6 19v-3.1a1.4 1.4 0 0 1 2.8 0V19" />
      <path d="M5 9.4v9.6M19 9.4v9.6" />
      <path d="M4.1 9.4a.9.9 0 0 1 1.8 0M18.1 9.4a.9.9 0 0 1 1.8 0" />
      <path d="M3 19h18" />
    </svg>
  );
}

function artFor(rec: NotificationRecord) {
  if (rec.priority === 'critical') return { icon: AlertTriangle, color: '#ef4444', label: 'Critical' };
  return KIND_ART[rec.kind] ?? KIND_ART.event;
}

function relativeTime(at: number, now: number): string {
  const diff = Math.round((now - at) / 1000);
  if (diff < 45) return 'just now';
  if (diff < 90) return '1 min ago';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 7200) return '1 hour ago';
  if (diff < 86400) return `${Math.round(diff / 3600)} hours ago`;
  const d = new Date(at);
  return d.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

// ─── Bell ────────────────────────────────────────────────────────────────────

export function NotificationBell({
  count,
  hasCritical,
  onClick,
  theme,
  title = 'Notifications',
}: {
  count: number;
  hasCritical: boolean;
  onClick: () => void;
  theme: NotifyTheme;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex items-center justify-center rounded-lg transition-colors"
      style={{
        width: 32,
        height: 32,
        background: theme.surface,
        border: `1px solid ${theme.bdr}`,
        color: count > 0 ? (hasCritical ? '#f87171' : theme.accent) : theme.sub,
      }}
      onMouseEnter={e => (e.currentTarget.style.background = theme.hover)}
      onMouseLeave={e => (e.currentTarget.style.background = theme.surface)}
      title={count > 0 ? `${count} unread notification${count === 1 ? '' : 's'}` : title}
      aria-label={title}
    >
      {count > 0 ? <BellRing size={16} /> : <Bell size={16} />}
      {count > 0 && (
        <span
          className="absolute flex items-center justify-center rounded-full text-[9.5px] font-bold tabular-nums"
          style={{
            top: -4,
            right: -4,
            minWidth: 16,
            height: 16,
            padding: '0 4px',
            background: hasCritical ? '#ef4444' : theme.accent,
            color: '#ffffff',
            // A critical badge pulses. It is the one thing here allowed to move.
            animation: hasCritical ? 'planner-notify-pulse 1.6s ease-in-out infinite' : undefined,
            boxShadow: `0 0 0 2px ${theme.bg}`,
          }}
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </button>
  );
}

// ─── Panel ───────────────────────────────────────────────────────────────────

export function NotificationPanel({
  open,
  onClose,
  grouped,
  unread,
  theme,
  snoozeOptions,
  onRead,
  onUnread,
  onReadAll,
  onSnooze,
  onAcknowledge,
  onComplete,
  onClear,
  onClearAll,
  onOpenItem,
  highlightKey,
}: {
  open: boolean;
  onClose: () => void;
  grouped: Array<{ label: string; items: NotificationRecord[] }>;
  unread: number;
  theme: NotifyTheme;
  snoozeOptions: number[];
  onRead: (keys: string[]) => void;
  onUnread: (keys: string[]) => void;
  onReadAll: () => void;
  onSnooze: (keys: string[], minutes: number) => void;
  onAcknowledge: (keys: string[]) => void;
  onComplete: (keys: string[]) => void;
  onClear: (keys: string[]) => void;
  onClearAll: () => void;
  onOpenItem?: (rec: NotificationRecord) => void;
  highlightKey?: string | null;
}) {
  const [filter, setFilter] = useState<'all' | 'unread'>('all');
  const [snoozeFor, setSnoozeFor] = useState<string | null>(null);
  const now = Date.now();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Opened from a notification: jump straight to the thing that was clicked.
  useEffect(() => {
    if (!open || !highlightKey) return;
    const el = document.getElementById(`notif-${cssId(highlightKey)}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [open, highlightKey]);

  const shown = useMemo(() => (
    grouped
      .map(g => ({ ...g, items: filter === 'unread' ? g.items.filter(i => !i.read) : g.items }))
      .filter(g => g.items.length > 0)
  ), [grouped, filter]);

  const total = useMemo(() => grouped.reduce((n, g) => n + g.items.length, 0), [grouped]);

  if (!open) return null;

  return (
    <>
      <div
        className="fixed inset-0 z-[85]"
        style={{ background: 'rgba(0,0,0,0.52)' }}
        onClick={onClose}
      />

      <aside
        className="fixed z-[86] flex flex-col shadow-2xl gpu-layer touch-scroll"
        style={{
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(420px, 100vw)',
          paddingTop: 'var(--safe-top)',
          paddingBottom: 'var(--safe-bottom)',
          background: theme.bg,
          borderLeft: `1px solid ${theme.bdr}`,
          animation: 'planner-notify-slide 140ms cubic-bezier(0.22, 1, 0.36, 1)',
          willChange: 'transform',
          contain: 'paint layout',
        }}
        role="dialog"
        aria-label="Notifications"
      >
        {/* Header */}
        <header
          className="flex items-center gap-2 px-4 shrink-0"
          style={{ height: 56, borderBottom: `1px solid ${theme.bdr}` }}
        >
          <Bell size={17} style={{ color: theme.accent }} />
          <h2 className="text-[15px] font-semibold" style={{ color: theme.text }}>Notifications</h2>
          {unread > 0 && (
            <span
              className="rounded-full px-1.5 py-[1px] text-[11px] font-semibold tabular-nums"
              style={{ background: `${theme.accent}22`, color: theme.accent }}
            >
              {unread}
            </span>
          )}
          <div className="flex-1" />
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 transition-colors"
            style={{ color: theme.sub }}
            onMouseEnter={e => (e.currentTarget.style.background = theme.hover)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            aria-label="Close notifications"
          >
            <X size={17} />
          </button>
        </header>

        {/* Toolbar */}
        <div
          className="flex items-center gap-1.5 px-3 py-2 shrink-0"
          style={{ borderBottom: `1px solid ${theme.bdr}` }}
        >
          <div className="inline-flex rounded-lg p-[2px]" style={{ background: theme.surface, border: `1px solid ${theme.bdr}` }}>
            {(['all', 'unread'] as const).map(f => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className="rounded-md px-2.5 py-[3px] text-[12px] font-medium capitalize transition-colors"
                style={{
                  background: filter === f ? theme.bg : 'transparent',
                  color: filter === f ? theme.text : theme.sub,
                }}
              >
                {f}
              </button>
            ))}
          </div>
          <div className="flex-1" />
          {unread > 0 && (
            <button
              type="button"
              onClick={onReadAll}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] transition-colors"
              style={{ color: theme.sub }}
              onMouseEnter={e => (e.currentTarget.style.background = theme.hover)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            >
              <CheckCheck size={13} /> Mark all read
            </button>
          )}
          {total > 0 && (
            <button
              type="button"
              onClick={onClearAll}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] transition-colors"
              style={{ color: theme.sub }}
              onMouseEnter={e => (e.currentTarget.style.background = theme.hover)}
              onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
              title="Remove every notification from this list"
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {shown.length === 0 && (
            <div className="flex flex-col items-center justify-center gap-2 py-20 px-6 text-center">
              <Inbox size={30} style={{ color: theme.sub, opacity: 0.55 }} />
              <p className="text-[13px]" style={{ color: theme.sub }}>
                {filter === 'unread' ? 'Nothing unread. You are on top of everything.' : 'No notifications yet.'}
              </p>
            </div>
          )}

          {shown.map(group => (
            <section key={group.label}>
              <h3
                className="sticky top-0 z-[1] px-4 py-1.5 text-[10.5px] font-semibold uppercase tracking-wider backdrop-blur"
                style={{ color: theme.sub, background: `${theme.bg}e6` }}
              >
                {group.label}
              </h3>

              {group.items.map(rec => {
                const art = artFor(rec);
                const Icon = art.icon;
                const snoozed = !!rec.snoozedUntil && rec.snoozedUntil > now;
                const highlighted = highlightKey === rec.key;

                return (
                  <article
                    key={rec.key}
                    id={`notif-${cssId(rec.key)}`}
                    className="group relative px-3 py-2.5 transition-colors cursor-pointer content-auto"
                    style={{
                      borderBottom: `1px solid ${theme.bdr}`,
                      background: highlighted ? `${theme.accent}14` : rec.read ? 'transparent' : `${art.color}0d`,
                      contain: 'paint layout',
                    }}
                    onClick={e => {
                      if ((e.target as HTMLElement).closest('button, [role="button"], a, input, select, textarea')) {
                        return;
                      }
                      if (!rec.read) onRead([rec.key]);
                    }}
                    onContextMenu={e => {
                      e.preventDefault();
                      if (!rec.read) onRead([rec.key]);
                    }}
                    onMouseDown={e => {
                      if (e.button === 1) {
                        e.preventDefault();
                      }
                    }}
                    onAuxClick={e => {
                      if (e.button === 1) {
                        e.preventDefault();
                        if (!rec.read) onRead([rec.key]);
                      }
                    }}
                    onMouseEnter={e => { if (!highlighted) e.currentTarget.style.background = theme.hover; }}
                    onMouseLeave={e => {
                      e.currentTarget.style.background = highlighted
                        ? `${theme.accent}14`
                        : rec.read ? 'transparent' : `${art.color}0d`;
                    }}
                  >
                    <div className="flex gap-2.5">
                      {/* Kind badge */}
                      <div
                        className="shrink-0 flex items-center justify-center rounded-lg"
                        style={{
                          width: 32, height: 32,
                          background: `${art.color}1f`,
                          color: art.color,
                          border: `1px solid ${art.color}33`,
                        }}
                        title={art.label}
                      >
                        <Icon size={16} />
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <button
                            type="button"
                            onClick={() => { onRead([rec.key]); onOpenItem?.(rec); }}
                            className="min-w-0 flex-1 text-left"
                          >
                            <p
                              className="truncate text-[13.5px] leading-tight"
                              style={{ color: theme.text, fontWeight: rec.read ? 400 : 600 }}
                            >
                              {rec.title}
                            </p>
                            <p className="truncate text-[12px] mt-0.5" style={{ color: theme.sub }}>
                              {rec.body}
                            </p>
                          </button>

                          {!rec.read && (
                            <span
                              className="mt-1.5 shrink-0 rounded-full"
                              style={{ width: 7, height: 7, background: art.color }}
                              aria-label="Unread"
                            />
                          )}
                        </div>

                        {/* Status chips: only shown when they say something real */}
                        <div className="flex flex-wrap items-center gap-1 mt-1.5">
                          <span className="text-[10.5px] tabular-nums" style={{ color: theme.sub }}>
                            {relativeTime(rec.firedAt, now)}
                          </span>
                          {rec.priority === 'critical' && !rec.acknowledgedAt && (
                            <Chip color="#ef4444" icon={<AlertTriangle size={9} />}>
                              critical{rec.alerts > 1 ? ` · ${rec.alerts}x` : ''}
                            </Chip>
                          )}
                          {snoozed && (
                            <Chip color="#a855f7" icon={<Moon size={9} />}>
                              snoozed to {new Date(rec.snoozedUntil!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </Chip>
                          )}
                          {rec.missed && <Chip color="#94a3b8" icon={<Clock size={9} />}>missed while away</Chip>}
                          {rec.late && !rec.missed && <Chip color="#f59e0b" icon={<Clock size={9} />}>delivered late</Chip>}
                          {rec.completed && <Chip color="#22c55e" icon={<Check size={9} />}>done</Chip>}
                          {rec.read && rec.readBy && rec.readBy !== 'this' && (
                            <Chip color={theme.sub}>read on another device</Chip>
                          )}
                        </div>

                        {/* Actions */}
                        <div className="flex flex-wrap items-center gap-1 mt-1.5">
                          {rec.priority === 'critical' && !rec.acknowledgedAt && (
                            <Action onClick={() => onAcknowledge([rec.key])} theme={theme} accent="#ef4444">
                              <AlertTriangle size={11} /> Acknowledge
                            </Action>
                          )}
                          {(rec.kind === 'task' || rec.kind === 'event') && !rec.completed && (
                            <Action onClick={() => onComplete([rec.key])} theme={theme} accent="#22c55e">
                              <Check size={11} /> Done
                            </Action>
                          )}
                          {!rec.read && (
                            <div className="relative">
                              <Action onClick={() => setSnoozeFor(snoozeFor === rec.key ? null : rec.key)} theme={theme}>
                                <AlarmClock size={11} /> Snooze
                              </Action>
                              {snoozeFor === rec.key && (
                                <div
                                  className="absolute left-0 top-full z-10 mt-1 flex gap-1 rounded-lg p-1 shadow-lg"
                                  style={{ background: theme.bg, border: `1px solid ${theme.bdr}` }}
                                  onClick={e => e.stopPropagation()}
                                >
                                  {snoozeOptions.map(m => (
                                    <button
                                      key={m}
                                      type="button"
                                      onClick={() => { onSnooze([rec.key], m); setSnoozeFor(null); }}
                                      className="rounded-md px-2 py-1 text-[11.5px] whitespace-nowrap transition-colors"
                                      style={{ color: theme.text }}
                                      onMouseEnter={e => (e.currentTarget.style.background = theme.hover)}
                                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                                    >
                                      {m < 60 ? `${m}m` : `${m / 60}h`}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          <Action onClick={() => (rec.read ? onUnread([rec.key]) : onRead([rec.key]))} theme={theme}>
                            {rec.read ? 'Mark unread' : <><Check size={11} /> Mark read</>}
                          </Action>
                          {onOpenItem && (
                            <Action onClick={() => { onRead([rec.key]); onOpenItem(rec); }} theme={theme}>
                              <ExternalLink size={11} /> Open
                            </Action>
                          )}
                          <div className="flex-1" />
                          <button
                            type="button"
                            onClick={() => onClear([rec.key])}
                            className="rounded p-1.5 opacity-70 sm:opacity-0 sm:group-hover:opacity-70 hover:!opacity-100 transition-opacity active:scale-90"
                            style={{ color: theme.sub }}
                            aria-label="Remove this notification"
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </section>
          ))}
        </div>
      </aside>
    </>
  );
}

function Chip({ color, icon, children }: { color: string; icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-0.5 rounded-full px-1.5 py-[1px] text-[10px] font-medium"
      style={{ background: `${color}1f`, color, border: `1px solid ${color}33` }}
    >
      {icon}{children}
    </span>
  );
}

function Action({
  onClick, theme, accent, children,
}: { onClick: () => void; theme: NotifyTheme; accent?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-[3px] text-[11px] transition-colors"
      style={{ color: accent ?? theme.sub, border: `1px solid ${accent ? `${accent}44` : 'transparent'}` }}
      onMouseEnter={e => (e.currentTarget.style.background = accent ? `${accent}1a` : theme.hover)}
      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
    >
      {children}
    </button>
  );
}

/** Notification keys contain colons and slashes, which are not valid in an id. */
const cssId = (key: string): string => key.replace(/[^a-zA-Z0-9_-]/g, '_');

// ─── In-app banner ───────────────────────────────────────────────────────────

/**
 * What the user actually sees when they are already looking at the planner. It
 * is deliberately not a generic toast: a critical banner will not dismiss
 * itself, because the entire point of critical is that it cannot be missed.
 */
export function NotificationBanner({
  rec,
  theme,
  snoozeOptions,
  onDismiss,
  onRead,
  onSnooze,
  onAcknowledge,
  onComplete,
  onOpen,
}: {
  rec: NotificationRecord | null;
  theme: NotifyTheme;
  snoozeOptions: number[];
  onDismiss: () => void;
  onRead: (keys: string[]) => void;
  onSnooze: (keys: string[], minutes: number) => void;
  onAcknowledge: (keys: string[]) => void;
  onComplete: (keys: string[]) => void;
  onOpen?: (rec: NotificationRecord) => void;
}) {
  const critical = rec?.priority === 'critical';

  useEffect(() => {
    if (!rec || critical) return;
    const id = window.setTimeout(onDismiss, 12000);
    return () => window.clearTimeout(id);
  }, [rec, critical, onDismiss]);

  if (!rec) return null;
  const art = artFor(rec);
  const Icon = art.icon;

  return (
    <div
      className="fixed z-[90] flex gap-3 rounded-xl p-3 shadow-2xl"
      style={{
        top: 16,
        right: 16,
        width: 'min(380px, calc(100vw - 32px))',
        background: theme.bg,
        border: `1px solid ${critical ? '#ef444488' : theme.bdr}`,
        boxShadow: critical
          ? '0 18px 44px rgba(0,0,0,0.5), 0 0 0 1px rgba(239,68,68,0.35), 0 0 26px rgba(239,68,68,0.28)'
          : '0 18px 44px rgba(0,0,0,0.4)',
        animation: 'planner-notify-drop 200ms cubic-bezier(0.2, 0.9, 0.3, 1.2)',
      }}
      role="alert"
    >
      <div
        className="shrink-0 flex items-center justify-center rounded-lg self-start"
        style={{
          width: 36, height: 36,
          background: `${art.color}1f`,
          color: art.color,
          border: `1px solid ${art.color}44`,
          animation: critical ? 'planner-notify-pulse 1.4s ease-in-out infinite' : undefined,
        }}
      >
        <Icon size={18} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold" style={{ color: theme.text }}>{rec.title}</p>
            <p className="text-[12.5px] mt-0.5" style={{ color: theme.sub }}>{rec.body}</p>
          </div>
          <button
            type="button"
            onClick={() => { onRead([rec.key]); onDismiss(); }}
            className="shrink-0 rounded p-1 transition-colors"
            style={{ color: theme.sub }}
            onMouseEnter={e => (e.currentTarget.style.background = theme.hover)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            aria-label="Dismiss"
          >
            <X size={15} />
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 mt-2">
          {critical && (
            <BannerButton onClick={() => { onAcknowledge([rec.key]); onDismiss(); }} accent="#ef4444" theme={theme} filled>
              Acknowledge
            </BannerButton>
          )}
          {(rec.kind === 'task' || rec.kind === 'event') && (
            <BannerButton onClick={() => { onComplete([rec.key]); onDismiss(); }} accent="#22c55e" theme={theme}>
              <Check size={12} /> Done
            </BannerButton>
          )}
          {snoozeOptions.slice(0, 2).map(m => (
            <BannerButton key={m} onClick={() => { onSnooze([rec.key], m); onDismiss(); }} theme={theme}>
              <AlarmClock size={12} /> {m}m
            </BannerButton>
          ))}
          {onOpen && (
            <BannerButton onClick={() => { onRead([rec.key]); onOpen(rec); onDismiss(); }} theme={theme}>
              Open <ChevronRight size={12} />
            </BannerButton>
          )}
        </div>
      </div>
    </div>
  );
}

function BannerButton({
  onClick, theme, accent, filled, children,
}: {
  onClick: () => void;
  theme: NotifyTheme;
  accent?: string;
  filled?: boolean;
  children: React.ReactNode;
}) {
  const color = accent ?? theme.text;
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors"
      style={{
        background: filled ? color : theme.surface,
        color: filled ? '#ffffff' : color,
        border: `1px solid ${filled ? color : theme.bdr}`,
      }}
      onMouseEnter={e => { if (!filled) e.currentTarget.style.background = theme.hover; }}
      onMouseLeave={e => { if (!filled) e.currentTarget.style.background = theme.surface; }}
    >
      {children}
    </button>
  );
}
