// ─── Planner agent: thinking picks, per model, per device ────────────────────
//
// Like the model pick, each device keeps its own (the PC app's two windows
// share one, since they share a profile). Sent with every typed message as
// `thinkSetting`; the server checks it against the model again.

import { useCallback, useEffect, useState } from 'react';

import { coerceThinkBook, resolveThink, type ThinkSetting } from './agentModels';

const KEY = 'planner-agent-think';

export function readThinkBook(): Record<string, ThinkSetting> {
  try { return coerceThinkBook(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch { return {}; }
}

/** The pick a message for `model` carries now, checked against what the model takes. */
export function thinkSettingFor(model: string): ThinkSetting {
  return resolveThink(model, readThinkBook()[model]);
}

const listeners = new Set<() => void>();

export function setThinkFor(model: string, s: ThinkSetting) {
  const book = { ...readThinkBook(), [model]: s };
  try { localStorage.setItem(KEY, JSON.stringify(book)); } catch { /* private mode */ }
  for (const l of listeners) l();
}

/** The whole book, live: this window's picks and the other window's (storage events). */
export function useThinkBook() {
  const [book, setBook] = useState(readThinkBook);
  useEffect(() => {
    const again = () => setBook(readThinkBook());
    listeners.add(again);
    const onStorage = (e: StorageEvent) => { if (e.key === KEY) again(); };
    window.addEventListener('storage', onStorage);
    return () => { listeners.delete(again); window.removeEventListener('storage', onStorage); };
  }, []);
  const setThink = useCallback((model: string, s: ThinkSetting) => setThinkFor(model, s), []);
  const settingOf = useCallback((model: string) => resolveThink(model, book[model]), [book]);
  return { book, setThink, settingOf };
}
