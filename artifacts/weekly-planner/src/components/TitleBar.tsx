import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { useDesktopFrame, windowControls, TITLE_BAR_HEIGHT } from '@/lib/desktopFrame';

/*
 * The PC app's own title bar, replacing the native Windows one (see
 * lib/desktopFrame.ts and MainApi in widget-window.py). A separate full-width
 * strip above every page: app icon and name on the left, today's date in the
 * middle, and Windows 11 style minimize / maximize / close on the right. The
 * whole strip is the window's caption (drag, double-click to maximize, Snap).
 * Renders nothing outside the desktop window.
 */

const BTN_W = 46;

function Glyph({ d, crisp = true }: { d: string; crisp?: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden
      fill="none" stroke="currentColor" strokeWidth="1" shapeRendering={crisp ? 'crispEdges' : undefined}>
      <path d={d} />
    </svg>
  );
}

function useToday() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

export function TitleBar() {
  const { active, maximized } = useDesktopFrame();
  const today = useToday();
  if (!active) return null;

  const btn =
    'h-full flex items-center justify-center transition-colors duration-100 ' +
    'text-foreground/70 hover:text-foreground focus:outline-none';
  const neutralHover = 'hover:bg-black/[0.06] dark:hover:bg-white/[0.08] active:bg-black/10 dark:active:bg-white/[0.05]';

  return (
    <div
      data-window-controls
      className="app-drag fixed top-0 inset-x-0 z-[1000] flex items-center select-none bg-card border-b border-border text-foreground"
      style={{ height: TITLE_BAR_HEIGHT }}
    >
      {/* Brand */}
      <div className="flex items-center gap-2 pl-3 min-w-0 flex-1">
        <img src="/favicon.svg" alt="" width={18} height={18} className="flex-shrink-0" draggable={false} />
        <span className="text-[12.5px] font-semibold tracking-tight truncate">Daily Planner</span>
      </div>

      {/* Today */}
      <div className="flex-shrink-0 text-[11.5px] font-medium tabular-nums text-foreground/60 px-4">
        {format(today, 'EEEE, MMMM d, yyyy')}
      </div>

      {/* Window buttons */}
      <div className="flex-1 flex justify-end h-full">
        <button
          type="button"
          onClick={windowControls.minimize}
          className={`${btn} ${neutralHover}`}
          style={{ width: BTN_W }}
          title="Minimize"
          aria-label="Minimize"
          tabIndex={-1}
        >
          <Glyph d="M0 5.5h10" />
        </button>
        <button
          type="button"
          onClick={windowControls.toggleMaximize}
          className={`${btn} ${neutralHover}`}
          style={{ width: BTN_W }}
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          tabIndex={-1}
        >
          {maximized
            ? <Glyph d="M0.5 2.5h7v7h-7z M2.5 2.5v-2h7v7h-2" />
            : <Glyph d="M0.5 0.5h9v9h-9z" />}
        </button>
        <button
          type="button"
          onClick={windowControls.close}
          className={`${btn} hover:bg-[#c42b1c] hover:text-white active:bg-[#c42b1c]/80 active:text-white/90`}
          style={{ width: BTN_W }}
          title="Close"
          aria-label="Close"
          tabIndex={-1}
        >
          <Glyph d="M0.5 0.5l9 9M9.5 0.5l-9 9" crisp={false} />
        </button>
      </div>
    </div>
  );
}
