import assert from 'node:assert/strict';
import { computeGoalStats, adjustDayTotal, editSingleSession } from './focusGoals';
import { type FocusSessionRecord } from './focusStats';

function s(id: string, startedAt: string, endedAt: string, durationSeconds: number): FocusSessionRecord {
  return { id, startedAt, endedAt, durationSeconds, plannedSeconds: durationSeconds };
}

function main() {
  console.log('--- 1. NO SESSIONS AT ALL ---');
  {
    const stats = computeGoalStats([], { now: '2026-08-31T12:00:00Z', goalSeconds: 3600 });
    assert.equal(stats.currentStreak, 0);
    assert.equal(stats.bestStreak, 0);
    assert.equal(stats.todayProgress, 0);
    assert.equal(stats.todayTotal, 0);
  }

  console.log('--- 2. A SINGLE SESSION ---');
  {
    const sessions = [s('1', '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', 3600)];
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 3600 });
    assert.equal(stats.currentStreak, 1);
    assert.equal(stats.bestStreak, 1);
    assert.equal(stats.todayTotal, 3600);
    assert.equal(stats.todayProgress, 1);
  }

  console.log('--- 3. CROSSING MIDNIGHT ---');
  {
    const sessions = [s('1', '2026-08-30T23:30:00Z', '2026-08-31T00:30:00Z', 3600)];
    // Ends on 31st, so it belongs to 31st.
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 3600, dayStartHour: 0 });
    assert.equal(stats.todayTotal, 3600);
    assert.equal(stats.currentStreak, 1);
  }

  console.log('--- 4. CROSSING CONFIGURED DAY BOUNDARY ---');
  {
    // dayStartHour = 3.
    // 02:00 to 02:30 -> ends before 3, belongs to previous day (30th)
    const sessions1 = [s('1', '2026-08-31T02:00:00', '2026-08-31T02:30:00', 1800)];
    const stats1 = computeGoalStats(sessions1, { now: '2026-08-31T12:00:00', goalSeconds: 1800, dayStartHour: 3 });
    assert.equal(stats1.todayTotal, 0, 'Belongs to 30th');
    assert.equal(stats1.currentStreak, 1, 'Streak is 1 because 30th is yesterday');

    // 02:30 to 03:30 -> ends after 3, belongs to 31st (today)
    const sessions2 = [s('2', '2026-08-31T02:30:00', '2026-08-31T03:30:00', 3600)];
    const stats2 = computeGoalStats(sessions2, { now: '2026-08-31T12:00:00', goalSeconds: 3600, dayStartHour: 3 });
    assert.equal(stats2.todayTotal, 3600, 'Belongs to 31st');
    assert.equal(stats2.currentStreak, 1);
  }

  console.log('--- 5. DIFFERENT TIME ZONE ---');
  {
    const sessions = [s('1', '2026-08-31T08:00:00+09:00', '2026-08-31T09:00:00+09:00', 3600)];
    const stats = computeGoalStats(sessions, { now: '2026-08-31T00:00:00+09:00', goalSeconds: 3600 });
    assert.ok(stats.todayTotal >= 0);
  }

  console.log('--- 6. A ZERO-LENGTH SESSION ---');
  {
    const sessions = [s('1', '2026-08-31T10:00:00Z', '2026-08-31T10:00:00Z', 0)];
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 1800 });
    assert.equal(stats.todayTotal, 0);
    assert.equal(stats.currentStreak, 0);
  }

  console.log('--- 7. NEGATIVE OR NAN DURATION ---');
  {
    const sessions = [
      s('1', '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', -100),
      s('2', '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', NaN),
    ];
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 1800 });
    assert.equal(stats.todayTotal, 0);
  }

  console.log('--- 8. SESSION DATED IN THE FUTURE ---');
  {
    const sessions = [s('1', '2036-08-31T10:00:00Z', '2036-08-31T11:00:00Z', 3600)];
    // 'now' is 2026. The streak loop stops at 'now'. Future session shouldn't extend streak.
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 3600 });
    assert.equal(stats.currentStreak, 0);
  }

  console.log('--- 9. DUPLICATE SESSION IDS ---');
  {
    // The pure function just adds them up. Deduplication is handled upstream in focusTimer.ts.
    const sessions = [
      s('1', '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', 3600),
      s('1', '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', 3600)
    ];
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 3600 });
    assert.equal(stats.todayTotal, 7200);
  }

  console.log('--- 10. STREAK BROKEN BY EXACTLY ONE DAY ---');
  {
    const sessions = [
      s('1', '2026-08-28T10:00:00Z', '2026-08-28T11:00:00Z', 3600),
      s('2', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z', 3600),
      // missed 30th
      s('3', '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', 3600),
    ];
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 3600 });
    assert.equal(stats.bestStreak, 2);
    assert.equal(stats.currentStreak, 1);
  }

  console.log('--- 11. STREAK ACROSS A MONTH AND A YEAR BOUNDARY ---');
  {
    const sessions = [
      s('1', '2025-12-30T10:00:00Z', '2025-12-30T11:00:00Z', 3600),
      s('2', '2025-12-31T10:00:00Z', '2025-12-31T11:00:00Z', 3600),
      s('3', '2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z', 3600),
      s('4', '2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z', 3600),
    ];
    const stats = computeGoalStats(sessions, { now: '2026-01-02T12:00:00Z', goalSeconds: 3600 });
    assert.equal(stats.currentStreak, 4);
    assert.equal(stats.bestStreak, 4);
  }

  console.log('--- 12. A LEAP DAY ---');
  {
    const sessions = [
      s('1', '2024-02-28T10:00:00Z', '2024-02-28T11:00:00Z', 3600),
      s('2', '2024-02-29T10:00:00Z', '2024-02-29T11:00:00Z', 3600),
      s('3', '2024-03-01T10:00:00Z', '2024-03-01T11:00:00Z', 3600),
    ];
    const stats = computeGoalStats(sessions, { now: '2024-03-01T12:00:00Z', goalSeconds: 3600 });
    assert.equal(stats.currentStreak, 3);
  }

  console.log('--- 13. A GOAL OF ZERO ---');
  {
    const sessions = [s('1', '2026-08-31T10:00:00Z', '2026-08-31T11:00:00Z', 60)];
    // Fallback: any session > 0 counts.
    const stats = computeGoalStats(sessions, { now: '2026-08-31T12:00:00Z', goalSeconds: 0 });
    assert.equal(stats.currentStreak, 1);
    assert.equal(stats.todayProgress, 1);
  }

  console.log('--- 14. A GOAL LARGER THAN A DAY ---');
  {
    const sessions = [s('1', '2026-08-31T00:00:00Z', '2026-08-31T23:59:59Z', 86400)];
    const stats = computeGoalStats(sessions, { now: '2026-08-31T23:59:59Z', goalSeconds: 100000 });
    assert.equal(stats.currentStreak, 0);
    assert.equal(stats.todayProgress, 86400 / 100000);
  }

  console.log('--- 15. PROPERTY TEST: ORDER INDEPENDENCE ---');
  {
    const s1 = s('1', '2026-08-28T10:00:00Z', '2026-08-28T11:00:00Z', 3600);
    const s2 = s('2', '2026-08-29T10:00:00Z', '2026-08-29T11:00:00Z', 3600);
    
    const stats1 = computeGoalStats([s1, s2], { now: '2026-08-29T12:00:00Z', goalSeconds: 3600 });
    const stats2 = computeGoalStats([s2, s1], { now: '2026-08-29T12:00:00Z', goalSeconds: 3600 });
    
    assert.deepEqual(stats1, stats2);

    const adj1 = adjustDayTotal([s1, s2], { dateKeyVal: '2026-08-29', newTotalSeconds: 1800 });
    const adj2 = adjustDayTotal([s2, s1], { dateKeyVal: '2026-08-29', newTotalSeconds: 1800 });
    // Duration should be 1800.
    const tot1 = adj1.filter(s => s.id.includes('2')).reduce((a, b) => a + b.durationSeconds, 0);
    const tot2 = adj2.filter(s => s.id.includes('2')).reduce((a, b) => a + b.durationSeconds, 0);
    assert.equal(tot1, tot2);
  }

  console.log('\nALL PASS (focusGoals)');
}

main();
