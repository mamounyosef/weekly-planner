import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import Home from '@/pages/home';
import Settings from '@/pages/settings';
import Widget from '@/pages/widget';
import { AnimatePresence, motion } from 'framer-motion';
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

  return (
    <div className="relative min-h-screen">
      <Home />
      <AnimatePresence>
        {isSettings && (
          <motion.div
            key="settings-overlay"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ duration: 0.15, ease: 'easeOut' }}
            className="fixed inset-0 z-[100] overflow-y-auto bg-background"
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
