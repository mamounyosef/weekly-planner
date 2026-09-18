// Tests for the sync health read-out, the module that turns raw sync status
// into "is anything wrong and, if so, what".
//
// WHY THIS DESERVES ITS OWN SUITE DESPITE BEING SMALL
// It is the layer a worried user reads. Every threshold here is a promise:
// "over 24 hours" must not fire at 23 hours, an offline phase must never be
// reported as healthy just because nothing is pending, and a null last-sync
// (a phone that has NEVER reached the PC) must say so in words rather than
// show a nonsense duration or crash on the arithmetic. Getting one of these
// wrong shows the user either false alarm or false comfort, and both teach
// them to ignore the panel.
//
// Run with: npx tsx src/lib/syncHealth.test.ts

import assert from 'node:assert/strict';
import { assessSyncHealth, formatTimeSince } from './syncHealth';
import type { SyncStatus } from './syncClient';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function status(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return {
    phase: 'idle',
    pending: 0,
    conflicts: 0,
    lastSyncedAt: null,
    label: '',
    ...overrides,
  };
}

function main() {
  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 1. A CURRENT, QUIET SYNC IS HEALTHY ---');
  {
    const now = 10_000_000;
    const h = assessSyncHealth(status({ lastSyncedAt: now - 5 * 60 * 1000 }), now);
    assert.equal(h.isHealthy, true, 'nothing wrong is healthy');
    assert.deepEqual(h.issues, [], 'with no issues listed');
    assert.equal(h.hasUnresolvedConflicts, false);
    assert.equal(h.hasPendingChanges, false);
    assert.equal(h.timeSinceLastSyncMs, 5 * 60 * 1000, 'age computed from the given clock');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 2. THE 24-HOUR THRESHOLD SITS EXACTLY WHERE IT SAYS ---');
  {
    const now = 5 * DAY;
    // At precisely 24h the comparison is strict-greater, so this is NOT stale:
    // a phone that synced this time yesterday is still fine.
    const edge = assessSyncHealth(status({ lastSyncedAt: now - DAY }), now);
    assert.equal(edge.isHealthy, true, 'exactly 24h is not "over 24 hours"');
    assert.deepEqual(edge.issues, []);

    const stale = assessSyncHealth(status({ lastSyncedAt: now - DAY - 1 }), now);
    assert.equal(stale.isHealthy, false, 'one millisecond past the day is stale');
    assert.ok(stale.issues.some(i => i.includes('24 hours')), 'and it is named as such');

    // Far past it stays stale and does not double-report.
    const ancient = assessSyncHealth(status({ lastSyncedAt: now - 40 * DAY }), now);
    assert.equal(ancient.issues.filter(i => i.includes('24 hours')).length, 1,
      'one staleness line, however ancient');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 3. A PHONE THAT HAS NEVER SYNCED SAYS SO WITHOUT CRASHING ---');
  {
    // `lastSyncedAt: null` is a REAL state — first launch, or the PC away since
    // install. Null arithmetic is exactly the kind of thing that produces
    // "NaNh ago" or an exception in a panel that was only trying to help.
    const h = assessSyncHealth(status({ lastSyncedAt: null }), 1_000);
    assert.equal(h.timeSinceLastSyncMs, null, 'no age is reported');
    assert.equal(h.isHealthy, true, 'never-synced is not itself an error');
    assert.deepEqual(h.issues, [], 'and raises no issue');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 4. OFFLINE AND ERROR ARE NEVER HEALTHY ---');
  {
    for (const phase of ['offline', 'error'] as const) {
      const h = assessSyncHealth(status({ phase }), 1_000);
      assert.equal(h.isHealthy, false, `${phase} is unhealthy`);
      assert.ok(h.issues.some(i => i.includes(phase)), `${phase} is named`);
    }
    // Even with a fresh sync timestamp and nothing pending — the transport
    // being down is itself the problem.
    const now = 10 * DAY;
    const quiet = assessSyncHealth(
      status({ phase: 'offline', lastSyncedAt: now - 1000 }), now,
    );
    assert.equal(quiet.isHealthy, false, 'offline is unhealthy even when current');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 5. CONFLICTS AND PENDING CHANGES ARE REPORTED SEPARATELY ---');
  {
    const now = 1_000_000;
    const conflicts = assessSyncHealth(
      status({ conflicts: 3, lastSyncedAt: now - 1000 }), now,
    );
    assert.equal(conflicts.hasUnresolvedConflicts, true);
    assert.equal(conflicts.hasPendingChanges, false, 'conflicts are not pending edits');
    assert.ok(conflicts.issues.some(i => i.includes('3 unresolved conflicts')),
      'the count is shown, not just the fact');

    const pending = assessSyncHealth(
      status({ pending: 7, lastSyncedAt: now - 1000 }), now,
    );
    assert.equal(pending.hasPendingChanges, true);
    assert.equal(pending.hasUnresolvedConflicts, false, 'pending edits are not conflicts');
    // Pending edits alone do not make the sync unhealthy: they are work in
    // flight, not a fault.
    assert.equal(pending.isHealthy, true, 'queued edits are normal operation');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 6. EVERY PROBLEM AT ONCE ---');
  {
    const now = 40 * DAY;
    const h = assessSyncHealth(status({
      phase: 'error',
      conflicts: 2,
      pending: 5,
      lastSyncedAt: now - 3 * DAY,
    }), now);
    assert.equal(h.isHealthy, false);
    assert.equal(h.issues.length, 3, 'transport, conflicts and staleness each report');
    assert.equal(h.hasUnresolvedConflicts, true);
    assert.equal(h.hasPendingChanges, true);
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 7. A SYNC STAMPED IN THE FUTURE IS NOT NEGATIVE STALENESS ---');
  {
    // Clock skew between devices is normal here (the whole engine exists
    // because of it). A lastSyncedAt slightly ahead of `now` must not produce
    // a negative age that then reads as "not stale" by accident or, worse,
    // breaks a UI that formats durations.
    const now = 1_000_000;
    const h = assessSyncHealth(status({ lastSyncedAt: now + 5 * 60 * 1000 }), now);
    assert.ok(h.timeSinceLastSyncMs !== null && h.timeSinceLastSyncMs < 0,
      'the raw age is passed through as computed');
    assert.equal(h.isHealthy, true, 'a slightly-future stamp is not an issue');
  }

  // ───────────────────────────────────────────────────────────────────────────
  console.log('--- 8. formatTimeSince SPEAKS HUMAN UNITS ---');
  {
    assert.equal(formatTimeSince(null), 'Never', 'no sync ever is said plainly');
    assert.equal(formatTimeSince(0), 'Just now');
    assert.equal(formatTimeSince(59 * 1000), 'Just now', 'under a minute is "just now"');
    assert.equal(formatTimeSince(60 * 1000), '1m ago');
    assert.equal(formatTimeSince(90 * 60 * 1000), '1h ago', 'minutes roll into hours');
    assert.equal(formatTimeSince(25 * HOUR), '1d ago', 'hours roll into days');
    assert.equal(formatTimeSince(3 * DAY + 2 * HOUR), '3d ago', 'remainder dropped, not rounded up');
  }

  console.log('\nALL PASS (sync health: thresholds, never-synced, offline/error, units)');
}

main();
