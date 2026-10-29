// ─── Planner agent: starred models, per device ───────────────────────────────
//
// Starred models sit at the top of every model menu (chat and voice share the
// list), each part still strongest first. Like the model pick, each device
// keeps its own; the PC app's two windows share one, since they share a profile.

import { useCallback, useEffect, useState } from 'react';

import { MODELS } from './agentModels';

const KEY = 'planner-agent-favs';

export function readFavModels(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => MODELS.some(m => m.id === id)) : [];
  } catch { return []; }
}

const listeners = new Set<() => void>();

export function toggleFavModel(id: string) {
  const now = readFavModels();
  const next = now.includes(id) ? now.filter(f => f !== id) : [...now, id];
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const l of listeners) l();
}

/** The starred list, live: this window's stars and the other window's (storage events). */
export function useFavModels() {
  const [favs, setFavs] = useState(readFavModels);
  useEffect(() => {
    const again = () => setFavs(readFavModels());
    listeners.add(again);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) again(); };
    window.addEventListener('storage', onStorage);
    return () => { listeners.delete(again); window.removeEventListener('storage', onStorage); };
  }, []);
  const toggle = useCallback((id: string) => toggleFavModel(id), []);
  return { favs, toggle };
}
