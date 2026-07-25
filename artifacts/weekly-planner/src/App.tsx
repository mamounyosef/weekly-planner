import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import Settings from '@/pages/settings';
import Widget from '@/pages/widget';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';

const queryClient = new QueryClient();

function Router() {
  const [location] = useLocation();

  if (location === '/widget') {
    return <Widget />;
  }

  if (location !== '/' && location !== '/settings') {
    return <NotFound />;
  }

  const isSettings = location === '/settings';

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
      <div className={isSettings ? 'pointer-events-none' : undefined} aria-hidden={isSettings}>
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
            className="fixed inset-0 z-[100] overflow-y-auto overscroll-contain bg-background"
          >
            <Settings />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
