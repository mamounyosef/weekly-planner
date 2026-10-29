// ─── Planner agent: starred models, on this phone ────────────────────────────
//
// Starred models sit at the top of every model sheet (chat and voice share the
// list), each part still strongest first. The phone keeps its own (the PC
// keeps its own), like the model pick.

import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

import { MODELS } from './agentModels';

const KEY = 'planner.agentFavs';

let cache: string[] | null = null;
let loading: Promise<string[]> | null = null;
const listeners = new Set<(f: string[]) => void>();

const known = (v: unknown): string[] => (Array.isArray(v) ? v.filter((id): id is string => MODELS.some(m => m.id === id)) : []);

export function loadFavModels(): Promise<string[]> {
  if (cache) return Promise.resolve(cache);
  loading ??= SecureStore.getItemAsync(KEY)
    .then(v => { cache = known(v ? JSON.parse(v) : []); return cache; })
    .catch(() => { cache = []; return cache; });
  return loading;
}

export async function toggleFavModel(id: string) {
  const now = await loadFavModels();
  const next = now.includes(id) ? now.filter(f => f !== id) : [...now, id];
  cache = next;
  for (const l of listeners) l(next);
  SecureStore.setItemAsync(KEY, JSON.stringify(next)).catch(() => {});
}

/** The starred list, live across every screen that shows it. */
export function useFavModels() {
  const [favs, setFavs] = useState<string[]>(cache ?? []);
  useEffect(() => {
    listeners.add(setFavs);
    loadFavModels().then(setFavs).catch(() => {});
    return () => { listeners.delete(setFavs); };
  }, []);
  const toggle = useCallback((id: string) => { void toggleFavModel(id); }, []);
  return { favs, toggle };
}
