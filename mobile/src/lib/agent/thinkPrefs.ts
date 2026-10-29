// ─── Planner agent: thinking picks, per model, on this phone ─────────────────
//
// Like the model pick, the phone keeps its own (the PC keeps its own). Sent
// with every typed message as `thinkSetting`; the server checks it against
// the model again.

import { useCallback, useEffect, useState } from 'react';
import * as SecureStore from 'expo-secure-store';

import { coerceThinkBook, resolveThink, type ThinkSetting } from './agentModels';

const KEY = 'planner.agentThink';

let cache: Record<string, ThinkSetting> | null = null;
let loading: Promise<Record<string, ThinkSetting>> | null = null;
const listeners = new Set<(b: Record<string, ThinkSetting>) => void>();

export function loadThinkBook(): Promise<Record<string, ThinkSetting>> {
  if (cache) return Promise.resolve(cache);
  loading ??= SecureStore.getItemAsync(KEY)
    .then(v => { cache = coerceThinkBook(v ? JSON.parse(v) : {}); return cache; })
    .catch(() => { cache = {}; return cache; });
  return loading;
}

/** The pick a message for `model` carries now, checked against what the model takes. */
export async function thinkSettingFor(model: string): Promise<ThinkSetting> {
  return resolveThink(model, (await loadThinkBook())[model]);
}

export async function setThinkFor(model: string, s: ThinkSetting) {
  const book = { ...(await loadThinkBook()), [model]: s };
  cache = book;
  for (const l of listeners) l(book);
  SecureStore.setItemAsync(KEY, JSON.stringify(book)).catch(() => {});
}

/** The whole book, live across every screen that shows it. */
export function useThinkBook() {
  const [book, setBook] = useState<Record<string, ThinkSetting>>(cache ?? {});
  useEffect(() => {
    listeners.add(setBook);
    loadThinkBook().then(setBook).catch(() => {});
    return () => { listeners.delete(setBook); };
  }, []);
  const setThink = useCallback((model: string, s: ThinkSetting) => { void setThinkFor(model, s); }, []);
  const settingOf = useCallback((model: string) => resolveThink(model, book[model]), [book]);
  return { book, setThink, settingOf };
}
