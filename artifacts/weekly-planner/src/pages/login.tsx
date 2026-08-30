import React, { useState } from 'react';
import { useAuth } from '@/lib/auth';
import { Lock, User, Eye, EyeOff, Calendar, ShieldCheck, AlertCircle, ArrowRight, Wifi } from 'lucide-react';
import { motion } from 'framer-motion';

/**
 * A failed sign-in has two completely different causes that used to look
 * identical on screen: the credentials are wrong, or the device cannot reach
 * the planner at all. /api/ping answers before authentication, so asking it
 * separates the two in one round trip and names the address being tried.
 */
export async function diagnoseConnection(
  where = typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
  fetchFn = typeof fetch !== 'undefined' ? fetch : globalThis.fetch,
  isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true,
): Promise<string> {
  if (isOnline === false) {
    return 'This device is offline. Reconnect it to the internet and try again.';
  }


  const control = new AbortController();
  const bail = setTimeout(() => control.abort(), 8000);
  try {
    const res = await fetchFn('/api/ping', { cache: 'no-store', signal: control.signal });
    if (res.ok) return `The planner answered at ${where}, so the connection is fine. Check the username and password.`;
    return `${where} answered with an error (${res.status}). The planner is running but refused the request.`;
  } catch (_) {
    return `Cannot reach ${where} from this device. The planner PC may be asleep, or this device cannot resolve that address. On a phone, try turning Private DNS off, or switch between wifi and mobile data.`;
  } finally {
    clearTimeout(bail);
  }
}

export default function LoginPage() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [diagnosis, setDiagnosis] = useState<string | null>(null);

  const diagnose = () => diagnoseConnection();


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Please enter both username and password.');
      return;
    }
    setError(null);
    setDiagnosis(null);
    setIsSubmitting(true);
    try {
      const res = await login(username.trim(), password);
      if (!res.ok) {
        setError(res.error || 'Invalid credentials. Please try again.');
        if (/connection|network|failed to fetch/i.test(res.error || '')) {
          setDiagnosis(await diagnose());
        }
      }
    } catch (_) {
      setError('Failed to connect to authentication service.');
      setDiagnosis(await diagnose());
    } finally {
      setIsSubmitting(false);
    }
  };

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
            <h1 className="text-xl font-bold tracking-tight text-white">Daily Planner</h1>
            <p className="text-xs text-zinc-400 mt-1 font-medium">Sign in with your personal account</p>
          </div>
        </div>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-center gap-2.5 p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-medium"
          >
            <AlertCircle className="w-4 h-4 flex-shrink-0 text-red-400" />
            <span>{error}</span>
          </motion.div>
        )}

        {diagnosis && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-start gap-2.5 p-3 -mt-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300/90 text-[11px] leading-relaxed font-medium"
          >
            <Wifi className="w-4 h-4 flex-shrink-0 mt-px text-amber-400" />
            <span>{diagnosis}</span>
          </motion.div>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="username" className="text-[11px] font-semibold tracking-wide uppercase text-zinc-400 px-1">
              Username
            </label>
            <div className="relative flex items-center">
              <User className="absolute left-3.5 w-4 h-4 text-zinc-500 pointer-events-none" />
              <input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Enter your username"
                autoFocus={typeof window !== 'undefined' ? !window.matchMedia('(pointer: coarse)').matches : true}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="username"
                spellCheck={false}
                enterKeyHint="next"
                disabled={isSubmitting}
                className="w-full h-11 pl-10 pr-3 rounded-xl bg-black/40 border border-white/10 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 transition-all"
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="password" className="text-[11px] font-semibold tracking-wide uppercase text-zinc-400 px-1">
              Password
            </label>
            <div className="relative flex items-center">
              <Lock className="absolute left-3.5 w-4 h-4 text-zinc-500 pointer-events-none" />
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter your password"
                autoComplete="current-password"
                spellCheck={false}
                enterKeyHint="go"
                disabled={isSubmitting}
                className="w-full h-11 pl-10 pr-10 rounded-xl bg-black/40 border border-white/10 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/60 focus:ring-2 focus:ring-emerald-500/20 transition-all"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                tabIndex={-1}
                className="absolute right-3 p-1 rounded-md text-zinc-500 hover:text-zinc-300 transition-colors"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-2 w-full h-11 rounded-xl bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 active:scale-[0.99] text-white text-sm font-semibold flex items-center justify-center gap-2 shadow-lg shadow-emerald-950/50 transition-all disabled:opacity-60 disabled:cursor-not-allowed cursor-pointer"
          >
            {isSubmitting ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
            ) : (
              <>
                <span>Sign In</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>

        <div className="pt-3 border-t border-white/5 flex items-center justify-center gap-2 text-center text-[11px] text-zinc-500">
          <ShieldCheck className="w-4 h-4 text-emerald-500/70" />
          <span>Discrete User Database • Zero Data Leakage</span>
        </div>
      </motion.div>
    </div>
  );
}
