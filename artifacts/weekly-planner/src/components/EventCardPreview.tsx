// A true-to-life miniature of a planner event card, for the Settings picker.
//
// It is built from `gcalChipColors` — the same function the grid and the side
// window use — and mirrors the real card chrome (border, radius, shadow, left
// accent strip, title + time line), so what you see here is what lands on the
// week grid.

import { gcalChipColors, type EventCardStyle } from '@/lib/gcalColor';

/** Width of the left colour strip on the 'minimal' style. Shared with the grid. */
export const ACCENT_BAR_W = 3;

export function EventCardPreview({
  style, dark, pageBg, hex, title, time, height = 46,
}: {
  style: EventCardStyle;
  dark: boolean;
  pageBg: string;
  hex: string;
  title: string;
  time: string;
  height?: number;
}) {
  const c = gcalChipColors(hex, { dark, style, pageBg });
  if (!c) return null;
  return (
    <div
      className="relative rounded-lg border overflow-hidden flex-1 min-w-0"
      style={{
        height,
        backgroundColor: c.bg,
        borderColor: c.border,
        color: c.text,
        boxShadow: c.boxShadow,
      }}
    >
      {c.accentBar && (
        <div
          className="absolute left-0 top-0 bottom-0"
          style={{ width: ACCENT_BAR_W, background: c.accentBar }}
        />
      )}
      <div className="absolute inset-0 flex flex-col justify-between px-2 py-1.5" style={{ paddingLeft: c.accentBar ? ACCENT_BAR_W + 7 : 8 }}>
        <div className="flex items-center gap-1.5 min-w-0">
          <span
            className="flex-shrink-0 w-3 h-3 rounded-full border"
            style={{ borderColor: `${c.text}50` }}
          />
          <span className="text-[11px] font-semibold truncate" style={{ color: c.text }}>
            {title}
          </span>
        </div>
        <span className="text-[9.5px] font-medium tabular-nums" style={{ color: c.textMuted }}>
          {time}
        </span>
      </div>
    </div>
  );
}

/**
 * The two-card sample shown under each style option: one saturated hue and one
 * cooler one, because some styles (solid, glowing) diverge a lot between hues.
 */
export function EventCardPreviewPair({
  style, dark, pageBg,
}: { style: EventCardStyle; dark: boolean; pageBg: string }) {
  return (
    <div className="flex gap-1.5 w-full">
      <EventCardPreview style={style} dark={dark} pageBg={pageBg} hex="#3b82f6" title="Deep work" time="9:00 – 10:30" />
      <EventCardPreview style={style} dark={dark} pageBg={pageBg} hex="#f97316" title="Gym" time="6:00 – 7:00" />
    </div>
  );
}
