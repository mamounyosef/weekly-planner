import assert from 'node:assert/strict';
import { groupConflicts, describeConflict, type DescribedConflict, type GroupedConflict } from './conflictText';
import type { SyncConflict } from './sync';

function makeConflict(
  id: string, store: any, entityId: string, field: string,
  winnerVal: any, winnerDevice: string, winnerAt: number,
  loserVal: any, loserDevice: string, loserAt: number,
  kind: 'field' | 'delete' = 'field'
): SyncConflict {
  return {
    id, store, entityId, field,
    winner: { value: winnerVal, device: winnerDevice, at: winnerAt, lamport: 2 },
    loser: { value: loserVal, device: loserDevice, at: loserAt, lamport: 1 },
    detectedAt: Math.max(winnerAt, loserAt),
    kind,
  };
}

function main() {
  const now = 1000000;
  
  console.log('--- 1. EMPTY LIST ---');
  {
    const res = groupConflicts([], now, () => 'Title');
    assert.deepEqual(res, []);
  }

  console.log('--- 2. MISSING TITLE, NO TITLE, AND DELETED ITEMS ---');
  {
    const c1 = makeConflict('c1', 'events', 'e1', 'title', 'A', 'pc', now, 'B', 'phone', now);
    const c2 = makeConflict('c2', 'events', 'e2', 'title', 'C', 'pc', now, 'D', 'phone', now);
    const c3 = makeConflict('c3', 'events', 'e3', 'title', 'E', 'pc', now, 'F', 'phone', now);
    const res = groupConflicts([c1, c2, c3], now, (store, id) => {
      if (id === 'e1') return undefined; // Deleted or unknown
      if (id === 'e2') return ''; // Empty title
      return '   '; // Whitespace title
    });
    assert.equal(res.length, 3);
    assert.equal(res[0].itemTitle, 'Untitled item');
    assert.equal(res[1].itemTitle, 'Untitled item');
    assert.equal(res[2].itemTitle, 'Untitled item');
  }

  console.log('--- 3. FIELD FORMATTING (EVERY FIELD TYPE + UNKNOWN) ---');
  {
    const testCases = [
      { field: 'title', w: 'Standup', l: 'Meeting', expW: 'Standup', expL: 'Meeting' },
      { field: 'startTime', w: '09:00', l: '09:30', expW: '09:00', expL: '09:30' },
      { field: 'weekKey', w: '2026-08-31', l: '2026-09-07', expW: '2026-08-31', expL: '2026-09-07' },
      { field: 'completed', w: true, l: false, expW: 'Yes', expL: 'No' },
      { field: 'color', w: 'sage', l: 'peach', expW: 'sage', expL: 'peach' },
      { field: 'categoryId', w: 'work', l: 'home', expW: 'work', expL: 'home' },
      { field: 'completedDates', w: ['2026-08-31'], l: [], expW: '2026-08-31', expL: '(none)' },
      { field: 'daysSpan', w: 3, l: 4, expW: '3', expL: '4' },
      { field: 'future_field', w: { nested: 1 }, l: null, expW: '{"nested":1}', expL: '(empty)' },
      { field: 'notes', w: 'very long string'.repeat(20), l: 'صلاة', expW: 'very long string'.repeat(20), expL: 'صلاة' },
      { field: 'title', w: 'Same', l: 'Same', expW: 'Same', expL: 'Same' },
      { field: 'title', w: '', l: '   ', expW: '(empty)', expL: '(empty)' },
    ];
    
    for (const [i, tc] of testCases.entries()) {
      const c = makeConflict(`c_${i}`, 'events', 'e1', tc.field, tc.w, 'pc', now, tc.l, 'phone', now);
      const desc = describeConflict(c, now);
      assert.equal(desc.winnerValue, tc.expW, `Winner field ${tc.field} mismatch`);
      assert.equal(desc.loserValue, tc.expL, `Loser field ${tc.field} mismatch`);
    }
  }

  console.log('--- 4. TIMES, DATES, FUTURE TIMESTAMPS ---');
  {
    const future = now + 60000; // 1 minute in the future
    const past = now - 3600000; // 1 hour ago
    
    const c1 = makeConflict('c1', 'events', 'e1', 'title', 'A', 'pc-desk', future, 'B', 'phone1', past);
    const desc = describeConflict(c1, now);
    
    assert.equal(desc.winnerTime, 'just now', 'Future timestamp should be just now');
    assert.equal(desc.loserTime, '1 hour ago', 'Past timestamp formatted correctly');
    assert.equal(desc.winnerLabel, 'PC');
    assert.equal(desc.loserLabel, 'phone');
  }

  console.log('--- 5. DEVICE LABELS ---');
  {
    const cases = [
      ['pc-home', 'PC'],
      ['android-1', 'phone'],
      ['phone-2', 'phone'],
      ['tablet-9', 'tablet'],
      ['unknown-device', 'unknown-device'],
    ];
    for (const [raw, expected] of cases) {
      const c = makeConflict('c1', 'events', 'e1', 'title', 'A', raw, now, 'B', 'pc', now);
      const desc = describeConflict(c, now);
      assert.equal(desc.winnerLabel, expected);
    }
  }

  console.log('--- 6. PROPERTY TEST: NEVER LOSES OR DUPLICATES A CONFLICT ---');
  {
    const conflicts: SyncConflict[] = [];
    for (let i = 0; i < 100; i++) {
      const store = i % 2 === 0 ? 'events' : 'tasks';
      const entityId = `e${i % 10}`; // 10 unique entities
      conflicts.push(makeConflict(`c${i}`, store, entityId, `field${i}`, i, 'pc', now, -i, 'phone', now));
    }
    
    // Add a delete conflict
    conflicts.push(makeConflict('c_del', 'events', 'e0', '__deleted', true, 'pc', now, false, 'phone', now, 'delete'));
    
    const groups = groupConflicts(conflicts, now, (s, id) => `Item ${id}`);
    
    let totalConflictsInGroups = 0;
    const seenIds = new Set<string>();
    
    for (const group of groups) {
      for (const desc of group.conflicts) {
        totalConflictsInGroups++;
        seenIds.add(desc.raw.id);
      }
    }
    
    assert.equal(totalConflictsInGroups, 101, 'Exact number of conflicts preserved');
    assert.equal(seenIds.size, 101, 'No duplicated IDs');
    assert.equal(groups.length, 10, '10 total entities');
  }

  console.log('\nALL PASS (conflictText: empty lists, defaults, field rendering, timestamps, grouping properties)');
}

main();
