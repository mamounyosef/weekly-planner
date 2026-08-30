import { useMemo, useState } from 'react';
import { AlertTriangle, Bell, BellOff, Check, ChevronDown, Plus, RotateCcw, X } from 'lucide-react';
import {
  OFFSET_PRESETS_ALL_DAY,
  OFFSET_PRESETS_TIMED,
  offsetChip,
  offsetLabel,
  type NotifyPriority,
  type NotifyRule,
  type NotifySpec,
} from '@/lib/notifications';

export interface NotifyTheme {
  darkMode: boolean;
  text: string;
  sub: string;
  bg: string;
  bdr: string;
  surface: string;
  hover: string;
  accent: string;
}

/**
 * The reminder editor, used in four places: the event dialog, the task editor,
 * the category editor and the global defaults in settings. They differ only in
 * what "inherit" means, which is why that is a prop rather than four copies.
 *
 *   `spec === null`  -> this thing is INHERITING. The editor shows what it will
 *                       do and where that comes from, and offers to customise.
 *   `spec !== null`  -> it has its own rules.
 *
 * `inheritedFrom` is the label of whatever it would fall back to. Passing
 * `null` for it (the global defaults themselves) hides the inherit affordance,
 * because there is nothing above them to fall back to.
 */
export function NotifyEditor({
  spec,
  effective,
  onChange,
  inheritedFrom,
  kind,
  theme,
  anchorHint,
  compact = false,
}: {
  spec: NotifySpec | undefined;
  /** What actually applies right now, whether inherited or owned. */
  effective: NotifySpec;
  onChange: (next: NotifySpec | undefined) => void;
  inheritedFrom: string | null;
  kind: 'timed' | 'allDay' | 'task';
  theme: NotifyTheme;
  /** e.g. "09:00 on Tue 25 Aug" or "All day, Wed 26 Aug". Drives the preview. */
  anchorHint?: { at: Date; label: string };
  compact?: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const [customValue, setCustomValue] = useState('30');
  const [customUnit, setCustomUnit] = useState<'minutes' | 'hours' | 'days' | 'weeks'>('minutes');
  const [customDir, setCustomDir] = useState<'before' | 'after'>('before');

  const owned = spec !== undefined;
  const presets = kind === 'allDay' ? OFFSET_PRESETS_ALL_DAY : OFFSET_PRESETS_TIMED;

  const rules = useMemo(
    () => [...effective.rules].sort((a, b) => a.offsetMin - b.offsetMin),
    [effective.rules],
  );

  /** Editing anything while inheriting takes ownership of the current rules. */
  const mutate = (next: Partial<NotifySpec>) => {
    onChange({ ...effective, ...next });
  };

  const addRule = (offsetMin: number) => {
    if (effective.rules.some(r => r.offsetMin === offsetMin)) return;
    const rule: NotifyRule = { id: `r${Date.now().toString(36)}`, offsetMin };
    mutate({ rules: [...effective.rules, rule], enabled: true });
    setAdding(false);
  };

  const removeRule = (id: string) => {
    const rest = effective.rules.filter(r => r.id !== id);
    // The last reminder removed means "no reminders", which is switched off
    // rather than an enabled rule set that can never fire.
    if (!rest.length) mutate({ rules: [{ id: 'r0', offsetMin: 0 }], enabled: false });
    else mutate({ rules: rest });
  };

  const addCustom = () => {
    const n = Math.abs(Math.round(Number(customValue) || 0));
    if (!n) return;
    const mult = customUnit === 'minutes' ? 1 : customUnit === 'hours' ? 60 : customUnit === 'days' ? 1440 : 10080;
    addRule((customDir === 'before' ? -1 : 1) * n * mult);
  };

  const critical = effective.priority === 'critical';

  const previewFor = (offsetMin: number): string | null => {
    if (!anchorHint) return null;
    const at = new Date(anchorHint.at.getTime() + offsetMin * 60_000);
    const sameDay = at.toDateString() === anchorHint.at.toDateString();
    const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return sameDay ? time : `${time}, ${at.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}`;
  };

  const chipStyle = (active: boolean): React.CSSProperties => ({
    background: active ? `${theme.accent}22` : theme.surface,
    border: `1px solid ${active ? `${theme.accent}66` : theme.bdr}`,
    color: active ? theme.accent : theme.text,
  });

  return (
    <div className="flex flex-col gap-2.5" style={{ color: theme.text }}>
      {/* ── Header: the on/off switch and where the settings come from ── */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => mutate({ enabled: !effective.enabled })}
          className="flex items-center gap-2 rounded-lg px-2 py-1 text-[13px] font-medium transition-colors"
          style={{
            background: effective.enabled ? `${theme.accent}1f` : theme.surface,
            border: `1px solid ${effective.enabled ? `${theme.accent}55` : theme.bdr}`,
            color: effective.enabled ? theme.accent : theme.sub,
          }}
          title={effective.enabled ? 'Reminders are on for this item' : 'Reminders are off for this item'}
        >
          {effective.enabled ? <Bell size={14} /> : <BellOff size={14} />}
          {effective.enabled ? 'Reminders on' : 'Reminders off'}
        </button>

        {!owned && inheritedFrom && (
          <span className="text-[11px] truncate" style={{ color: theme.sub }}>
            following {inheritedFrom}
          </span>
        )}
        {owned && inheritedFrom && (
          <button
            type="button"
            onClick={() => onChange(undefined)}
            className="flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5 transition-colors"
            style={{ color: theme.sub }}
            onMouseEnter={e => (e.currentTarget.style.background = theme.hover)}
            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
            title={`Go back to ${inheritedFrom}`}
          >
            <RotateCcw size={11} /> use {inheritedFrom}
          </button>
        )}
      </div>

      {effective.enabled && (
        <>
          {/* ── The rules themselves ── */}
          <div className="flex flex-wrap items-center gap-1.5">
            {rules.map(rule => {
              const preview = previewFor(rule.offsetMin);
              return (
                <span
                  key={rule.id}
                  className="group inline-flex items-center gap-1 rounded-full pl-2.5 pr-1 py-[3px] text-[12px]"
                  style={chipStyle(true)}
                  title={preview ? `${offsetLabel(rule.offsetMin)} — notifies at ${preview}` : offsetLabel(rule.offsetMin)}
                >
                  {compact ? offsetChip(rule.offsetMin) : offsetLabel(rule.offsetMin)}
                  {preview && !compact && (
                    <span className="text-[11px] opacity-70">· {preview}</span>
                  )}
                  <button
                    type="button"
                    onClick={() => removeRule(rule.id)}
                    className="rounded-full p-[2px] opacity-50 hover:opacity-100 transition-opacity"
                    aria-label={`Remove the ${offsetLabel(rule.offsetMin)} reminder`}
                  >
                    <X size={11} />
                  </button>
                </span>
              );
            })}

            {rules.length < 10 && (
              <button
                type="button"
                onClick={() => setAdding(v => !v)}
                className="inline-flex items-center gap-1 rounded-full px-2 py-[3px] text-[12px] transition-colors"
                style={chipStyle(false)}
              >
                <Plus size={12} /> Add
                <ChevronDown size={11} className="opacity-60" style={{ transform: adding ? 'rotate(180deg)' : undefined }} />
              </button>
            )}
          </div>

          {/* ── The picker ── */}
          {adding && (
            <div
              className="rounded-lg p-2 flex flex-col gap-2"
              style={{ background: theme.surface, border: `1px solid ${theme.bdr}` }}
            >
              <div className="flex flex-wrap gap-1">
                {presets.map(offset => {
                  const already = effective.rules.some(r => r.offsetMin === offset);
                  return (
                    <button
                      key={offset}
                      type="button"
                      disabled={already}
                      onClick={() => addRule(offset)}
                      className="rounded-md px-2 py-1 text-[11.5px] transition-colors disabled:opacity-35 disabled:cursor-not-allowed"
                      style={{ background: theme.bg, border: `1px solid ${theme.bdr}`, color: theme.text }}
                      onMouseEnter={e => { if (!already) e.currentTarget.style.background = theme.hover; }}
                      onMouseLeave={e => (e.currentTarget.style.background = theme.bg)}
                    >
                      {offsetLabel(offset)}
                    </button>
                  );
                })}
              </div>

              <div className="flex flex-wrap items-center gap-1.5 pt-1" style={{ borderTop: `1px solid ${theme.bdr}` }}>
                <span className="text-[11px]" style={{ color: theme.sub }}>Or</span>
                <input
                  value={customValue}
                  onChange={e => setCustomValue(e.target.value.replace(/[^0-9]/g, ''))}
                  inputMode="numeric"
                  className="w-14 rounded-md px-2 py-1 text-[12px] outline-none"
                  style={{ background: theme.bg, border: `1px solid ${theme.bdr}`, color: theme.text }}
                  aria-label="Custom reminder amount"
                />
                <select
                  value={customUnit}
                  onChange={e => setCustomUnit(e.target.value as typeof customUnit)}
                  className="rounded-md px-1.5 py-1 text-[12px] outline-none"
                  style={{ background: theme.bg, border: `1px solid ${theme.bdr}`, color: theme.text }}
                  aria-label="Custom reminder unit"
                >
                  <option value="minutes">minutes</option>
                  <option value="hours">hours</option>
                  <option value="days">days</option>
                  <option value="weeks">weeks</option>
                </select>
                <select
                  value={customDir}
                  onChange={e => setCustomDir(e.target.value as typeof customDir)}
                  className="rounded-md px-1.5 py-1 text-[12px] outline-none"
                  style={{ background: theme.bg, border: `1px solid ${theme.bdr}`, color: theme.text }}
                  aria-label="Before or after"
                >
                  <option value="before">before</option>
                  <option value="after">after</option>
                </select>
                <button
                  type="button"
                  onClick={addCustom}
                  className="rounded-md px-2 py-1 text-[12px] font-medium"
                  style={{ background: theme.accent, color: theme.darkMode ? '#0b0b0d' : '#ffffff' }}
                >
                  <Check size={13} />
                </button>
              </div>
            </div>
          )}

          {/* ── Priority ── */}
          <div className="flex items-center gap-1.5">
            <div className="inline-flex rounded-lg p-[2px]" style={{ background: theme.surface, border: `1px solid ${theme.bdr}` }}>
              {(['normal', 'critical'] as NotifyPriority[]).map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => mutate({ priority: p })}
                  className="flex items-center gap-1 rounded-md px-2 py-[3px] text-[11.5px] font-medium transition-colors"
                  style={{
                    background: effective.priority === p
                      ? (p === 'critical' ? '#ef444426' : theme.bg)
                      : 'transparent',
                    color: effective.priority === p
                      ? (p === 'critical' ? '#f87171' : theme.text)
                      : theme.sub,
                  }}
                >
                  {p === 'critical' && <AlertTriangle size={11} />}
                  {p === 'critical' ? 'Critical' : 'Normal'}
                </button>
              ))}
            </div>
            <span className="text-[11px] leading-tight" style={{ color: theme.sub }}>
              {critical
                ? 'Stays on screen, sounds an alarm and repeats until acknowledged on any device.'
                : 'One notification on every device.'}
            </span>
          </div>
        </>
      )}
    </div>
  );
}

/** One-line summary for a collapsed row, e.g. on an event card menu. */
export function NotifySummary({ spec, from }: { spec: NotifySpec; from?: string }) {
  if (!spec.enabled) return <>No reminders</>;
  const parts = [...spec.rules].sort((a, b) => a.offsetMin - b.offsetMin).map(r => offsetChip(r.offsetMin));
  return <>{parts.join(', ')}{spec.priority === 'critical' ? ' · critical' : ''}{from ? ` · ${from}` : ''}</>;
}
