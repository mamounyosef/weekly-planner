import type { SyncStatus } from './syncClient';

export interface SyncHealth {
  isHealthy: boolean;
  status: SyncStatus;
  timeSinceLastSyncMs: number | null;
  hasUnresolvedConflicts: boolean;
  hasPendingChanges: boolean;
  issues: string[];
}

export function assessSyncHealth(
  status: SyncStatus,
  now: number = Date.now(),
): SyncHealth {
  const timeSinceLastSyncMs = status.lastSyncedAt ? now - status.lastSyncedAt : null;
  const issues: string[] = [];

  if (status.phase === 'error' || status.phase === 'offline') {
    issues.push(`Transport is currently ${status.phase}.`);
  }

  if (status.conflicts > 0) {
    issues.push(`There are ${status.conflicts} unresolved conflicts.`);
  }

  // If we haven't synced in 24 hours, flag it
  if (timeSinceLastSyncMs !== null && timeSinceLastSyncMs > 24 * 60 * 60 * 1000) {
    issues.push(`Last sync was over 24 hours ago.`);
  }

  const hasUnresolvedConflicts = status.conflicts > 0;
  const hasPendingChanges = status.pending > 0;
  
  const isHealthy = issues.length === 0 && status.phase !== 'offline' && status.phase !== 'error';

  return {
    isHealthy,
    status,
    timeSinceLastSyncMs,
    hasUnresolvedConflicts,
    hasPendingChanges,
    issues,
  };
}

export function formatTimeSince(ms: number | null): string {
  if (ms === null) return 'Never';
  if (ms < 60000) return 'Just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
