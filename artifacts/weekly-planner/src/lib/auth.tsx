import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

export interface AuthUser {
  username: string;
  name: string;
}

interface AuthContextType {
  user: AuthUser | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<{ ok: boolean; error?: string }>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const WIDGET_ID_RE = /^[a-f0-9]{64}$/;

/**
 * The native widget receives a random pairing id from its Python host. It is
 * not a user session or a password; it only lets the local server recognise
 * which WebView is waiting for the signed-in desktop app to approve it.
 */
function widgetPairingId(): string | null {
  if (typeof window === 'undefined') return null;
  const id = new URLSearchParams(window.location.search).get('widgetSession');
  return id && WIDGET_ID_RE.test(id) ? id : null;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const pairingId = widgetPairingId();
  const [pairingGraceExpired, setPairingGraceExpired] = useState(() => !pairingId);
  const checkInFlightRef = useRef(false);

  const postWidgetAuth = useCallback(async (path: string, body?: Record<string, string>) => {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body || {}),
    });
  }, []);

  const registerWidget = useCallback(async () => {
    if (!pairingId) return false;
    try {
      const res = await postWidgetAuth('/api/widget-auth/register', { widgetId: pairingId });
      return res.ok;
    } catch (_) {
      return false;
    }
  }, [pairingId, postWidgetAuth]);

  const claimWidgetSession = useCallback(async (): Promise<AuthUser | null> => {
    if (!pairingId) return null;
    const registered = await registerWidget();
    if (!registered) return null;
    try {
      const res = await postWidgetAuth('/api/widget-auth/claim', { widgetId: pairingId });
      if (!res.ok) return null;
      const data = await res.json();
      return data.authenticated && data.user ? data.user as AuthUser : null;
    } catch (_) {
      return null;
    }
  }, [pairingId, postWidgetAuth, registerWidget]);

  const activateRegisteredWidgets = useCallback(async () => {
    try {
      await postWidgetAuth('/api/widget-auth/activate');
    } catch (_) {
      // The normal auth check will surface a real server connection failure.
    }
  }, [postWidgetAuth]);

  const checkAuth = useCallback(async () => {
    if (checkInFlightRef.current) return;
    checkInFlightRef.current = true;
    try {
      // A native widget must use the desktop-pairing path exclusively. Falling
      // back to a regular browser cookie here would let a stale WebView session
      // outlive the main desktop app's selected account.
      if (pairingId) {
        setUser(await claimWidgetSession());
        return;
      }
      const res = await fetch('/api/auth/me', {
        headers: { 'Cache-Control': 'no-cache' }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authenticated && data.user) {
          setUser(data.user);
          void activateRegisteredWidgets();
          setIsLoading(false);
          return;
        }
      }
      setUser(null);
    } catch (err) {
      console.error('Failed to check auth:', err);
      setUser(null);
    } finally {
      checkInFlightRef.current = false;
      setIsLoading(false);
    }
  }, [activateRegisteredWidgets, claimWidgetSession, pairingId]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  // The widget may start before Chrome has completed its authenticated boot.
  // Keep its pairing registration alive and claim the session shortly after the
  // main window appears, without ever showing a password prompt.
  useEffect(() => {
    if (!pairingId) return;
    const id = window.setInterval(() => { void checkAuth(); }, 2_000);
    return () => window.clearInterval(id);
  }, [checkAuth, pairingId]);

  // Do not flash an unnecessary username/password form while the two desktop
  // windows are starting at the same time. If the main app genuinely is not
  // signed in, the normal form remains available after this short grace period.
  useEffect(() => {
    if (!pairingId) return;
    const id = window.setTimeout(() => setPairingGraceExpired(true), 8_000);
    return () => window.clearTimeout(id);
  }, [pairingId]);

  // A widget can be opened after the main page, not only at application boot.
  // Re-pairing at a low rate makes that path automatic too, and is confined to
  // the loopback server.
  useEffect(() => {
    if (pairingId || !user) return;
    const id = window.setInterval(() => { void activateRegisteredWidgets(); }, 5_000);
    return () => window.clearInterval(id);
  }, [activateRegisteredWidgets, pairingId, user]);

  const login = useCallback(async (username: string, password: string): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, ...(pairingId ? { widgetId: pairingId } : {}) }),
      });
      const data = await res.json();
      if (res.ok && data.success && data.user) {
        try {
          localStorage.clear();
        } catch (_) {}
        if (pairingId) {
          // The widget's login fallback still uses its revocable widget cookie,
          // never a second copy of the main browser session.
          setUser(await claimWidgetSession() || data.user);
        } else {
          setUser(data.user);
          void activateRegisteredWidgets();
        }
        return { ok: true };
      }
      return { ok: false, error: data.error || 'Invalid credentials' };
    } catch (err) {
      return { ok: false, error: 'Connection error while signing in' };
    }
  }, [activateRegisteredWidgets, claimWidgetSession, pairingId]);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      console.error('Logout error:', err);
    }
    try {
      localStorage.clear();
      sessionStorage.clear();
    } catch (_) {}
    setUser(null);
    window.location.href = '/';
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading: isLoading || (!!pairingId && !pairingGraceExpired && !user),
        isAuthenticated: !!user,
        login,
        logout,
        refreshAuth: checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
