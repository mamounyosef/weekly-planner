import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import { AnimatePresence, motion } from 'framer-motion';
import { lazy, Suspense, useEffect } from 'react';

// Split out of the main bundle. The calendar is what every launch shows first,
// and it was waiting on the settings screen and the side widget to download,
// parse and compile before it could paint — on a phone that is real time spent
// staring at nothing. Both are fetched the moment they are actually opened,
// and the browser caches them by hash from then on.
const Settings = lazy(() => import('@/pages/settings'));
const Widget = lazy(() => import('@/pages/widget'));
import LoginPage from '@/pages/login';
import { AuthProvider, useAuth } from '@/lib/auth';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

function AuthenticatedApp() {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen w-full bg-[#0a0b0d] flex items-center justify-center">
        <div className="w-6 h-6 border-2 border-emerald-500/20 border-t-emerald-500 rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return <Router />;
}

function Router() {
  const [location] = useLocation();

  if (location === '/widget') {
    return (
      <Suspense fallback={null}>
        <Widget />
      </Suspense>
    );
  }

  if (location !== '/' && !location.startsWith('/settings')) {
    return <NotFound />;
  }

  const isSettings = location === '/settings' || location.startsWith('/settings');

  useEffect(() => {
    if (!isSettings) return;

    const previousHtmlOverflow = document.documentElement.style.overflow;
    const previousBodyOverflow = document.body.style.overflow;

    document.documentElement.style.overflow = 'hidden';
    document.body.style.overflow = 'hidden';

    return () => {
      document.documentElement.style.overflow = previousHtmlOverflow;
      document.body.style.overflow = previousBodyOverflow;
    };
  }, [isSettings]);

  return (
    <div className="relative min-h-screen">
      {/* Home stays mounted under the settings overlay so its state and scroll
          position survive. While covered it must be inert: no pointer events and
          hidden from assistive tech, or it keeps reacting behind the overlay. */}
      {/* `visibility: hidden` while covered. The settings overlay is opaque, but
          without this the calendar underneath keeps being painted — and it
          repaints every second for the clock and the now-line — which is what
          made scrolling settings on a phone feel like it was dropping frames.
          Not `display: none`: that would reset the calendar's scroll position,
          and getting back to exactly where you were is the point of keeping it
          mounted at all. */}
      <div
        className={isSettings ? 'pointer-events-none' : undefined}
        style={isSettings ? { visibility: 'hidden' } : undefined}
        aria-hidden={isSettings}
      >
        <Home />
      </div>
      <AnimatePresence>
        {isSettings && (
          <motion.div
            key="settings-overlay"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            // overscroll-contain: reaching the end of the settings page must not
            // hand the remaining scroll to the planner underneath.
            className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-background gpu-layer"
            style={{ willChange: 'transform, opacity' }}
          >
            <Suspense fallback={null}>
              <Settings />
            </Suspense>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function App() {
  // Warm the split chunks once the calendar is up and the main thread is idle,
  // so tapping Settings still opens instantly — the split only moves the cost
  // off the critical path, it doesn't add a wait later.
  useEffect(() => {
    const warm = () => { void import('@/pages/settings'); };
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (idle) {
      idle(warm, { timeout: 4000 });
      return;
    }
    const id = window.setTimeout(warm, 2500);
    return () => window.clearTimeout(id);
  }, []);

  return (
    <TooltipProvider>
      <AuthProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <AuthenticatedApp />
        </WouterRouter>
        <Toaster />
      </AuthProvider>
    </TooltipProvider>
  );
}

export default App;
