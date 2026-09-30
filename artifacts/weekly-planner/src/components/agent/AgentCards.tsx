// The three cards the assistant can put in the conversation:
//   QuestionCard  – multiple-choice questions it is waiting on
//   ApprovalCard  – deletions that need an explicit Approve
//   ReportCard    – the ground-truth list of what actually changed
//
// The report is rendered from ChangeSets written by code after reading the
// saved data back. Nothing on it comes from the model's own words.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowRight, BadgeCheck, CalendarDays, Check, CircleHelp, Copy, CornerDownLeft, Loader2,
  ShieldAlert, Trash2, Undo2,
} from 'lucide-react';

import type { AgentApproval, AgentQuestion, AgentQuestionAnswer, ChangeSet } from '@/lib/agent/agentTypes';
import { buildReport, reportAsText, summarize, type Tone } from '@/lib/agent/agentReport';

export interface AgentTheme {
  darkMode: boolean;
  text: string;
  sub: string;
  bg: string;
  bdr: string;
  surface: string;
  hover: string;
  accent: string;
}

const TONE: Record<Tone, { light: [string, string]; dark: [string, string] }> = {
  added: { light: ['#dcfce7', '#15803d'], dark: ['rgba(34,197,94,0.16)', '#4ade80'] },
  updated: { light: ['#dbeafe', '#1d4ed8'], dark: ['rgba(59,130,246,0.18)', '#93c5fd'] },
  deleted: { light: ['#fee2e2', '#b91c1c'], dark: ['rgba(239,68,68,0.18)', '#fca5a5'] },
  done: { light: ['#ede9fe', '#6d28d9'], dark: ['rgba(139,92,246,0.2)', '#c4b5fd'] },
  skipped: { light: ['#f1f5f9', '#475569'], dark: ['rgba(148,163,184,0.16)', '#cbd5e1'] },
  failed: { light: ['#fef3c7', '#b45309'], dark: ['rgba(245,158,11,0.18)', '#fcd34d'] },
};

export function toneColors(tone: Tone, dark: boolean) {
  const [bg, fg] = dark ? TONE[tone].dark : TONE[tone].light;
  return { bg, fg };
}

/** The frame every card shares: a coloured header strip and a body. */
function Shell({ theme, color, icon, title, subtitle, right, children }: {
  theme: AgentTheme; color: string; icon: React.ReactNode; title: React.ReactNode; subtitle?: React.ReactNode;
  right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div
      className="rounded-2xl overflow-hidden"
      style={{ background: theme.surface, border: `1px solid ${theme.bdr}`, boxShadow: theme.darkMode ? '0 1px 0 rgba(255,255,255,0.03) inset, 0 8px 24px rgba(0,0,0,0.25)' : '0 6px 20px rgba(15,23,42,0.06)' }}
    >
      <div className="flex items-center gap-2.5 px-3.5 py-2.5" style={{ background: `linear-gradient(90deg, ${color}1f, transparent 70%)`, borderBottom: `1px solid ${theme.bdr}` }}>
        <span className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: `${color}26`, color }}>{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-bold leading-tight" style={{ color: theme.text }}>{title}</div>
          {subtitle && <div className="text-[11px] leading-tight mt-0.5" style={{ color: theme.sub }}>{subtitle}</div>}
        </div>
        {right}
      </div>
      {children}
    </div>
  );
}

// ─── Questions ───────────────────────────────────────────────────────────────

export function QuestionCard({ questions, answers, active, theme, onSubmit }: {
  questions: AgentQuestion[];
  answers?: AgentQuestionAnswer[];
  active: boolean;
  theme: AgentTheme;
  onSubmit: (answers: AgentQuestionAnswer[]) => Promise<void>;
}) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [focusQ, setFocusQ] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const complete = questions.every(q => (picked[q.id]?.length ?? 0) > 0 || (other[q.id] ?? '').trim());

  const toggle = (q: AgentQuestion, label: string) => {
    setPicked(p => {
      const cur = p[q.id] ?? [];
      if (q.multiSelect) return { ...p, [q.id]: cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label] };
      return { ...p, [q.id]: cur[0] === label ? [] : [label] };
    });
  };

  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(questions.map(q => ({
        questionId: q.id,
        // Keep the options' own order, whatever order they were tapped in.
        selected: q.options.map(o => o.label).filter(l => (picked[q.id] ?? []).includes(l)),
        ...((other[q.id] ?? '').trim() ? { other: other[q.id].trim() } : {}),
      })));
    } catch (e: any) {
      setErr(e?.message ?? 'Could not send the answer.');
      setBusy(false);
    }
  };

  // Number keys pick an option of the focused question, like Claude Code.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!rootRef.current || !document.body.contains(rootRef.current)) return;
      const n = Number(e.key);
      const q = questions[focusQ];
      if (q && n >= 1 && n <= q.options.length) {
        e.preventDefault();
        toggle(q, q.options[n - 1].label);
        if (!q.multiSelect && focusQ < questions.length - 1) setFocusQ(focusQ + 1);
      } else if (e.key === 'Enter' && complete) {
        e.preventDefault();
        submit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (answers && !active) {
    return (
      <div className="rounded-2xl px-3.5 py-3 space-y-2" style={{ border: `1px solid ${theme.bdr}`, background: theme.surface }}>
        {questions.map(q => {
          const a = answers.find(x => x.questionId === q.id);
          const parts = [...(a?.selected ?? []), ...(a?.other ? [a.other] : [])];
          return (
            <div key={q.id} className="text-[12px]" dir="auto">
              <div style={{ color: theme.sub }}>{q.question}</div>
              <div className="font-semibold flex items-center gap-1.5 mt-0.5" style={{ color: theme.text }}>
                <CornerDownLeft size={12} style={{ color: theme.accent }} />
                {parts.length ? parts.join(', ') : 'No answer'}
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <Shell
        theme={theme}
        color={theme.accent}
        icon={<CircleHelp size={15} />}
        title={questions.length === 1 ? 'Quick question' : `${questions.length} quick questions`}
        subtitle="Pick an option (keys 1 to 4) or type your own"
      >
        <div className="p-3.5 space-y-4">
          {questions.map((q, qi) => (
            <div key={q.id} className="space-y-2" onFocus={() => setFocusQ(qi)} onMouseEnter={() => setFocusQ(qi)}>
              <div className="flex items-start gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md flex-shrink-0 mt-0.5" style={{ background: `${theme.accent}22`, color: theme.accent }}>{q.header}</span>
                <div className="text-[13px] font-semibold leading-snug" style={{ color: theme.text }} dir="auto">{q.question}</div>
              </div>
              <div className="space-y-1.5">
                {q.options.map((o, oi) => {
                  const on = (picked[q.id] ?? []).includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      disabled={busy}
                      onClick={() => toggle(q, o.label)}
                      className="w-full text-left rounded-xl px-3 py-2.5 flex items-start gap-2.5 transition-all"
                      style={{
                        border: `1.5px solid ${on ? theme.accent : theme.bdr}`,
                        background: on ? `${theme.accent}14` : 'transparent',
                        transform: on ? 'translateX(2px)' : undefined,
                      }}
                    >
                      <span
                        className="mt-0.5 flex-shrink-0 flex items-center justify-center text-[10px] font-bold rounded-md"
                        style={{ width: 18, height: 18, background: on ? theme.accent : theme.hover, color: on ? '#fff' : theme.sub }}
                      >
                        {on ? <Check size={11} strokeWidth={3} /> : oi + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-[12.5px] font-semibold" style={{ color: theme.text }} dir="auto">{o.label}</span>
                        {o.description && <span className="block text-[11.5px] leading-snug mt-0.5" style={{ color: theme.sub }} dir="auto">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
                <input
                  value={other[q.id] ?? ''}
                  disabled={busy}
                  onChange={e => setOther(o => ({ ...o, [q.id]: e.target.value }))}
                  onKeyDown={e => { e.stopPropagation(); if (e.key === 'Enter') submit(); }}
                  placeholder={q.multiSelect ? 'Anything else? (optional)' : 'Or type your own answer'}
                  dir="auto"
                  className="w-full rounded-xl px-3 py-2 text-[12.5px] outline-none"
                  style={{ border: `1.5px dashed ${(other[q.id] ?? '').trim() ? theme.accent : theme.bdr}`, background: 'transparent', color: theme.text }}
                />
              </div>
            </div>
          ))}
          {err && <div className="text-[12px]" style={{ color: '#ef4444' }}>{err}</div>}
          <button
            type="button"
            disabled={!complete || busy}
            onClick={submit}
            className="w-full rounded-xl py-2.5 text-[13px] font-semibold text-white flex items-center justify-center gap-2 transition-opacity"
            style={{ background: `linear-gradient(135deg, ${theme.accent}, ${theme.accent}cc)`, opacity: !complete || busy ? 0.45 : 1 }}
          >
            {busy ? <Loader2 size={14} className="animate-spin" /> : <ArrowRight size={14} />} Continue
          </button>
        </div>
      </Shell>
    </div>
  );
}

// ─── Approval ────────────────────────────────────────────────────────────────

export function ApprovalCard({ approval, decision, active, theme, onDecide }: {
  approval: AgentApproval;
  decision?: { approved: boolean; at: number; note?: string };
  active: boolean;
  theme: AgentTheme;
  onDecide: (approved: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState<null | 'yes' | 'no'>(null);
  const [err, setErr] = useState<string | null>(null);
  const red = theme.darkMode ? '#f87171' : '#dc2626';
  const n = approval.deletions.length;

  const go = async (yes: boolean) => {
    setBusy(yes ? 'yes' : 'no');
    setErr(null);
    try { await onDecide(yes); } catch (e: any) { setErr(e?.message ?? 'Could not send.'); setBusy(null); }
  };

  const waiting = !decision && active;
  return (
    <Shell
      theme={theme}
      color={decision && !decision.approved ? theme.sub : red}
      icon={<ShieldAlert size={15} />}
      title={decision ? (decision.approved ? `Deleted with your approval` : 'Kept, nothing deleted') : `Delete ${n} item${n === 1 ? '' : 's'}?`}
      subtitle={waiting ? 'Nothing is deleted until you approve' : approval.reason}
    >
      <div className="p-3.5 space-y-3">
        {waiting && <div className="text-[12.5px]" style={{ color: theme.text }} dir="auto">{approval.reason}</div>}
        <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${theme.bdr}` }}>
          {approval.deletions.map((d, i) => (
            <div key={`${d.id}-${d.scopeLabel}`} className="px-3 py-2.5 flex items-start gap-2.5" style={{ borderTop: i ? `1px solid ${theme.bdr}` : undefined }}>
              <span className="w-1 self-stretch rounded-full flex-shrink-0" style={{ background: red, opacity: decision && !decision.approved ? 0.3 : 0.9 }} />
              <div className="min-w-0 flex-1">
                <div className="text-[12.5px] font-semibold truncate" style={{ color: theme.text, textDecoration: decision?.approved ? 'line-through' : undefined }} dir="auto">{d.title}</div>
                <div className="text-[11.5px] tabular-nums" style={{ color: theme.sub }}>{d.when}{d.repeats ? `  ·  ${d.repeats}` : ''}</div>
                <div className="text-[11px] font-semibold mt-0.5" style={{ color: red }}>{d.scopeLabel}</div>
              </div>
            </div>
          ))}
        </div>
        {err && <div className="text-[12px]" style={{ color: '#ef4444' }}>{err}</div>}
        {waiting && (
          <div className="flex gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => go(false)}
              className="flex-1 rounded-xl py-2.5 text-[13px] font-semibold flex items-center justify-center gap-1.5"
              style={{ border: `1px solid ${theme.bdr}`, color: theme.text, opacity: busy ? 0.6 : 1 }}
            >
              {busy === 'no' && <Loader2 size={14} className="animate-spin" />} Keep them
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => go(true)}
              className="flex-1 rounded-xl py-2.5 text-[13px] font-semibold text-white flex items-center justify-center gap-1.5"
              style={{ background: red, opacity: busy ? 0.6 : 1 }}
            >
              {busy === 'yes' ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />} Delete {n === 1 ? 'it' : `all ${n}`}
            </button>
          </div>
        )}
      </div>
    </Shell>
  );
}

// ─── Report ──────────────────────────────────────────────────────────────────

const STAT_ORDER: Array<{ action: keyof ReturnType<typeof summarize>['counts']; label: string; tone: Tone }> = [
  { action: 'added', label: 'added', tone: 'added' },
  { action: 'updated', label: 'changed', tone: 'updated' },
  { action: 'completed', label: 'ticked', tone: 'done' },
  { action: 'reopened', label: 'un-ticked', tone: 'updated' },
  { action: 'deleted', label: 'deleted', tone: 'deleted' },
  { action: 'skipped', label: 'already there', tone: 'skipped' },
  { action: 'failed', label: 'not done', tone: 'failed' },
];

export function ReportCard({ sets, timeFormat, theme, onUndo, onOpenDate }: {
  sets: ChangeSet[];
  timeFormat: '12h' | '24h';
  theme: AgentTheme;
  onUndo: (ids: string[]) => Promise<void>;
  onOpenDate?: (date: string) => void;
}) {
  const groups = useMemo(() => buildReport(sets, timeFormat), [sets, timeFormat]);
  const summary = useMemo(() => summarize(sets), [sets]);
  const [undoing, setUndoing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const total = sets.reduce((n, s) => n + s.entries.length, 0);
  const [expanded, setExpanded] = useState(total <= 14);

  const undoable = sets.filter(s => !s.undoneAt && s.entries.some(e => e.action !== 'skipped' && e.action !== 'failed'));
  const onlyNoop = sets.every(s => s.entries.every(e => e.action === 'skipped' || e.action === 'failed'));
  const allUndone = !onlyNoop && undoable.length === 0 && sets.some(s => s.undoneAt);
  const notes = sets.map(s => s.undoNote).filter(Boolean) as string[];

  const doUndo = async () => {
    setUndoing(true);
    setErr(null);
    try { await onUndo(undoable.map(s => s.id).reverse()); } catch (e: any) { setErr(e?.message ?? 'Undo failed.'); }
    setUndoing(false);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reportAsText(sets, timeFormat));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  const ok = theme.darkMode ? '#4ade80' : '#15803d';
  let shown = 0;

  return (
    <Shell
      theme={theme}
      color={allUndone ? theme.sub : onlyNoop ? theme.sub : ok}
      icon={allUndone ? <Undo2 size={15} /> : <BadgeCheck size={15} />}
      title={allUndone ? 'Undone' : 'What changed'}
      subtitle={summary.unverified ? `${summary.unverified} not confirmed on disk` : 'Verified against your saved planner'}
      right={(
        <button type="button" onClick={copy} title="Copy this report as text" className="p-1.5 rounded-lg transition-colors" style={{ color: theme.sub }}>
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      )}
    >
      {/* The numbers first, so the outcome is readable in one glance. */}
      <div className="flex flex-wrap gap-1.5 px-3.5 pt-3">
        {STAT_ORDER.filter(s => summary.counts[s.action]).map(s => {
          const c = toneColors(s.tone, theme.darkMode);
          return (
            <span key={s.action} className="text-[11.5px] font-bold px-2 py-1 rounded-lg tabular-nums" style={{ background: c.bg, color: c.fg }}>
              {summary.counts[s.action]} {s.label}
            </span>
          );
        })}
      </div>

      {summary.unverified > 0 && (
        <div className="mx-3.5 mt-3 flex items-start gap-2 px-3 py-2 rounded-xl text-[11.5px]" style={{ background: theme.darkMode ? 'rgba(245,158,11,0.1)' : '#fffbeb', color: theme.darkMode ? '#fcd34d' : '#b45309' }}>
          <AlertTriangle size={13} className="mt-0.5 flex-shrink-0" />
          {summary.unverified === 1 ? 'One item' : `${summary.unverified} items`} could not be read back right after saving. Check {summary.unverified === 1 ? 'it' : 'them'} in the calendar.
        </div>
      )}

      <div className="px-3.5 py-3 space-y-3">
        {groups.map(g => {
          if (!expanded && shown >= 8) return null;
          return (
            <div key={g.heading}>
              <button
                type="button"
                disabled={!g.date || !onOpenDate}
                onClick={() => g.date && onOpenDate?.(g.date)}
                className="flex items-center gap-1.5 mb-1.5 text-[10.5px] font-bold uppercase tracking-wider group"
                style={{ color: theme.sub }}
                title={g.date && onOpenDate ? 'Show this day in the calendar' : undefined}
              >
                <CalendarDays size={11} />
                {g.heading}
                {g.date && onOpenDate && <ArrowRight size={10} className="opacity-0 group-hover:opacity-100 transition-opacity" />}
              </button>
              <div className="rounded-xl overflow-hidden" style={{ border: `1px solid ${theme.bdr}` }}>
                {g.rows.map((r, ri) => {
                  if (!expanded && shown >= 8) return null;
                  shown++;
                  const c = toneColors(r.tone, theme.darkMode);
                  const struck = r.entry.action === 'deleted';
                  const bar = r.facts?.color && /^#/.test(r.facts.color) ? r.facts.color : c.fg;
                  return (
                    <div
                      key={r.key}
                      className="flex items-stretch gap-2.5 px-2.5 py-2 transition-colors"
                      style={{ borderTop: ri ? `1px solid ${theme.bdr}` : undefined, opacity: r.entry.action === 'skipped' ? 0.75 : 1 }}
                    >
                      <span className="w-1 rounded-full flex-shrink-0" style={{ background: bar, opacity: struck ? 0.35 : 0.9 }} />
                      <div className="w-[74px] flex-shrink-0 pt-px">
                        <div className="text-[11px] font-semibold tabular-nums leading-tight" style={{ color: theme.text }}>
                          {r.facts?.allDay ? 'All day' : r.facts?.startTime ? r.time.split(' to ')[0] : r.facts?.kind === 'task' ? 'Task' : ''}
                        </div>
                        {r.facts?.endTime && !r.facts.allDay && (
                          <div className="text-[10.5px] tabular-nums leading-tight" style={{ color: theme.sub }}>
                            {r.time.split(' to ')[1]}
                          </div>
                        )}
                        {r.facts?.allDay && r.facts.endDate && <div className="text-[10.5px] leading-tight" style={{ color: theme.sub }}>{r.time.replace('All day, ', '')}</div>}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-1.5">
                          <span
                            className="text-[12.5px] font-semibold leading-snug flex-1 min-w-0"
                            style={{ color: theme.text, textDecoration: struck ? 'line-through' : undefined, opacity: struck ? 0.7 : 1 }}
                            dir="auto"
                          >{r.facts?.title}</span>
                          <span className="text-[9.5px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-md flex-shrink-0" style={{ background: c.bg, color: c.fg }}>{r.word}</span>
                        </div>
                        {(r.chips.length > 0 || !r.entry.verified) && (
                          <div className="flex flex-wrap items-center gap-1 mt-1">
                            {r.chips.map(ch => (
                              <span key={ch.label} className="text-[10.5px] px-1.5 py-0.5 rounded-md flex items-center gap-1" style={{ background: theme.hover, color: theme.sub }}>
                                {ch.color && <span className="inline-block rounded-full" style={{ width: 6, height: 6, background: ch.color }} />}
                                {ch.label}
                              </span>
                            ))}
                            {!r.entry.verified && (
                              <span className="text-[10.5px] px-1.5 py-0.5 rounded-md flex items-center gap-1" style={{ background: 'rgba(245,158,11,0.15)', color: '#d97706' }}>
                                <AlertTriangle size={10} /> not confirmed
                              </span>
                            )}
                          </div>
                        )}
                        {r.diffs.length > 0 && (
                          <div className="mt-1.5 space-y-0.5">
                            {r.diffs.map(d => (
                              <div key={d.field} className="text-[11.5px] flex flex-wrap items-center gap-1.5">
                                <span style={{ color: theme.sub }}>{d.label}</span>
                                <span className="px-1 rounded" style={{ color: theme.sub, textDecoration: 'line-through', background: theme.hover }}>{d.before}</span>
                                <ArrowRight size={11} style={{ color: theme.sub }} />
                                <span className="px-1 rounded font-semibold" style={{ color: theme.text, background: `${theme.accent}1f` }}>{d.after}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {r.entry.note && <div className="text-[11px] mt-1" style={{ color: theme.sub }} dir="auto">{r.entry.note}</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {!expanded && (
          <button type="button" onClick={() => setExpanded(true)} className="w-full text-[12px] font-semibold py-1.5 rounded-lg" style={{ color: theme.accent, background: `${theme.accent}12` }}>
            Show all {total} changes
          </button>
        )}
      </div>

      {(undoable.length > 0 || allUndone || err || notes.length > 0) && (
        <div className="flex items-center justify-between gap-2 px-3.5 py-2.5" style={{ borderTop: `1px solid ${theme.bdr}` }}>
          <div className="text-[11.5px] min-w-0" style={{ color: err ? '#ef4444' : theme.sub }}>
            {err ?? (allUndone || notes.length ? ['Undone.', ...notes].join(' ') : 'Not what you wanted?')}
          </div>
          {undoable.length > 0 && (
            <button
              type="button"
              onClick={doUndo}
              disabled={undoing}
              className="text-[12px] font-semibold px-3 py-1.5 rounded-lg flex items-center gap-1.5 flex-shrink-0 transition-colors"
              style={{ border: `1px solid ${theme.bdr}`, color: theme.text, background: theme.hover }}
            >
              {undoing ? <Loader2 size={13} className="animate-spin" /> : <Undo2 size={13} />} Undo {undoable.length > 1 || total > 1 ? 'all' : ''}
            </button>
          )}
        </div>
      )}
    </Shell>
  );
}

export function ErrorNote({ text, theme }: { text: string; theme: AgentTheme }) {
  return (
    <div className="rounded-xl px-3 py-2.5 text-[12px] flex items-start gap-2" style={{ border: '1px solid rgba(245,158,11,0.4)', color: theme.darkMode ? '#fcd34d' : '#b45309', background: theme.darkMode ? 'rgba(245,158,11,0.08)' : '#fffbeb' }}>
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
      <span dir="auto">{text}</span>
    </div>
  );
}

export default React.memo(ReportCard);
