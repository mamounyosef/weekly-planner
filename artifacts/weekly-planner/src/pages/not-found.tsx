import React from 'react';
import { useLocation } from 'wouter';
import { Calendar, AlertCircle, ArrowLeft } from 'lucide-react';
import { motion } from 'framer-motion';

export default function NotFound() {
  const [, setLocation] = useLocation();

  return (
    <div className="min-h-screen w-full flex items-center justify-center p-4 bg-[#0a0b0d] text-zinc-100 selection:bg-emerald-500/30 selection:text-emerald-200 font-sans">
      <div className="fixed inset-0 overflow-hidden pointer-events-none -z-10">
        <div className="absolute -top-40 left-1/2 -translate-x-1/2 w-[600px] h-[600px] bg-emerald-600/10 blur-[120px] rounded-full" />
        <div className="absolute -bottom-40 left-1/2 -translate-x-1/2 w-[500px] h-[350px] bg-blue-600/10 blur-[120px] rounded-full" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.25, ease: 'easeOut' }}
        className="w-full max-w-[420px] rounded-2xl border border-white/10 bg-[#121316]/90 backdrop-blur-xl p-7 shadow-2xl shadow-black/80 flex flex-col gap-6"
      >
        <div className="flex flex-col items-center text-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-tr from-emerald-600/30 via-emerald-500/20 to-teal-500/10 border border-emerald-500/30 flex items-center justify-center shadow-inner shadow-emerald-500/20">
            <Calendar className="w-7 h-7 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white">404 — Page Not Found</h1>
            <p className="text-xs text-zinc-400 mt-1 font-medium">The requested page could not be found.</p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium">
          <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
          <span>The URL does not match any active planner route.</span>
        </div>

        <button
          type="button"
          onClick={() => setLocation('/')}
          className="mt-2 w-full h-11 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 active:scale-[0.99] text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50 transition-all cursor-pointer"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>Return to Planner</span>
        </button>
      </motion.div>
    </div>
  );
}
