import { useEffect, useRef, useState } from 'react';

/**
 * A number box you can actually type in.
 *
 * Plain `<input type="number">` bound straight to state rewrites what you type on every
 * keystroke — clamping "4" up to the minimum, refusing an empty box, turning a half-typed
 * number into a different one. This keeps whatever you type as text, and only commits when
 * you leave the field or press Enter. Invalid input is reported instead of being silently
 * "corrected"; Escape puts the previous value back.
 */
export function NumberField({
  value,
  onCommit,
  min,
  max,
  step = 1,
  integer = true,
  oddOnly = false,
  validateExtra,
  disabled = false,
  className = '',
  style,
  wrapClassName = '',
  wrapStyle,
  showErrorText = true,
  ariaLabel,
}: {
  value: number;
  onCommit: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  oddOnly?: boolean;
  /** Extra rule that depends on other settings — return an error message, or null when fine. */
  validateExtra?: (n: number) => string | null;
  disabled?: boolean;
  className?: string;
  style?: React.CSSProperties;
  wrapClassName?: string;
  wrapStyle?: React.CSSProperties;
  showErrorText?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState<string | null>(null);
  const focused = useRef(false);

  // Follow the value when it changes underneath us (reset to defaults, a sync from the
  // server, calibration writing thresholds) — but never while the field is being edited.
  useEffect(() => {
    if (!focused.current) {
      setDraft(String(value));
      setError(null);
    }
  }, [value]);

  const validate = (raw: string): { ok: true; n: number } | { ok: false; msg: string } => {
    const t = raw.trim();
    if (t === '') return { ok: false, msg: 'Enter a number' };
    const n = Number(t);
    if (!Number.isFinite(n)) return { ok: false, msg: 'Not a number' };
    if (integer && !Number.isInteger(n)) return { ok: false, msg: 'Whole numbers only' };
    if (min !== undefined && n < min) return { ok: false, msg: `Must be ${max !== undefined ? `between ${min} and ${max}` : `at least ${min}`}` };
    if (max !== undefined && n > max) return { ok: false, msg: `Must be ${min !== undefined ? `between ${min} and ${max}` : `at most ${max}`}` };
    if (oddOnly && Math.abs(n) % 2 !== 1) return { ok: false, msg: 'Odd numbers only' };
    const extra = validateExtra?.(n);
    if (extra) return { ok: false, msg: extra };
    return { ok: true, n };
  };

  const commit = (raw: string) => {
    const r = validate(raw);
    if (r.ok) {
      setError(null);
      setDraft(String(r.n));
      if (r.n !== value) onCommit(r.n);
    } else {
      setError(r.msg);
    }
  };

  const nudge = (dir: 1 | -1) => {
    const base = Number(draft.trim());
    const from = Number.isFinite(base) ? base : value;
    let next = from + dir * (oddOnly ? Math.max(2, step) : step);
    if (min !== undefined) next = Math.max(min, next);
    if (max !== undefined) next = Math.min(max, next);
    next = integer ? Math.round(next) : next;
    setDraft(String(next));
    commit(String(next));
  };

  const invalid = error !== null;

  return (
    <span className={wrapClassName} style={{ display: 'inline-flex', flexDirection: 'column', gap: 2, minWidth: 0, ...wrapStyle }}>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        aria-label={ariaLabel}
        aria-invalid={invalid}
        title={error ?? undefined}
        disabled={disabled}
        value={draft}
        onFocus={() => { focused.current = true; }}
        onChange={e => {
          setDraft(e.target.value);
          if (error) setError(null); // stop shouting while they are still typing
        }}
        onBlur={e => { focused.current = false; commit(e.target.value); }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(draft); }
          else if (e.key === 'Escape') { e.preventDefault(); setDraft(String(value)); setError(null); (e.target as HTMLInputElement).blur(); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); nudge(1); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); nudge(-1); }
        }}
        className={className}
        style={invalid ? { ...style, borderColor: '#ef4444', color: '#ef4444' } : style}
      />
      {invalid && showErrorText && (
        <span className="text-[10px] leading-tight" style={{ color: '#ef4444' }}>{error}</span>
      )}
    </span>
  );
}
