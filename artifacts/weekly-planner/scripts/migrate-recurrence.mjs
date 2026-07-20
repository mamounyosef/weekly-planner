// One-off migration: old modification-domain model → Google-style recur model.
//
//  • Old recurring records (scope:'all', one per weekday) collapse into ONE master
//    with a weekly `recur` rule (byWeekday = all its weekdays; 7 days → daily).
//    The representative keeps its Google id; redundant siblings become tombstones
//    so their now-orphaned Google events get deleted on the next sync.
//  • Old single records (scope:'week') become plain non-repeating events.
//  • Old bookkeeping tombstones (deleted:true, no Google id) are dropped.
//
// Usage: node scripts/migrate-recurrence.mjs [path-to-database.json]
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.argv[2] || resolve(__dirname, '../../../database/database.json');

const ANCHOR_WEEK = '2025-01-05'; // a Sunday — anchors repeating masters in-range
const OBSOLETE = ['scope', 'seriesId', 'overridesSeriesId', 'gCalRecurSig'];
const strip = (o) => { const n = { ...o }; for (const k of OBSOLETE) delete n[k]; return n; };

const raw = JSON.parse(readFileSync(dbPath, 'utf-8'));
const now = Date.now();

const out = {};
let dropped = 0, singles = 0, tombstones = 0;
const recurringGroups = new Map(); // key → records[]

for (const ev of Object.values(raw)) {
  if (ev.deleted) {
    // Old bookkeeping tombstone. Only keep it if it still owns a Google event that
    // must be deleted (none do in practice) — otherwise drop.
    if (ev.gCalId) { out[ev.id] = strip({ ...ev, deleted: true }); tombstones++; }
    else dropped++;
    continue;
  }
  if (ev.scope === 'all') {
    const key = [ev.content, ev.startTime, ev.endTime, ev.color, !!ev.noCheckbox, !!ev.allDay, ev.daysSpan || 1].join('|');
    (recurringGroups.get(key) ?? recurringGroups.set(key, []).get(key)).push(ev);
    continue;
  }
  // scope 'week' (or legacy) → plain non-repeating event.
  out[ev.id] = strip({ ...ev, deleted: false });
  singles++;
}

let masters = 0;
for (const group of recurringGroups.values()) {
  const byWeekday = [...new Set(group.map(r => r.dayIndex || 0))].sort((a, b) => a - b);
  // Prefer a representative that already has a Google id (so we update, not orphan).
  const rep = group.find(r => r.gCalId) || group[0];
  const recur = byWeekday.length >= 7
    ? { freq: 'daily', interval: 1 }
    : { freq: 'weekly', interval: 1, byWeekday };

  out[rep.id] = strip({
    ...rep,
    weekKey: ANCHOR_WEEK,
    dayIndex: byWeekday[0],
    recur,
    deleted: false,
    updatedAt: now, // force a push so Google reflects the collapsed rule
  });
  masters++;

  // Siblings with their own Google event → tombstone so those orphans get deleted.
  for (const sib of group) {
    if (sib.id === rep.id) continue;
    if (sib.gCalId) { out[sib.id] = strip({ ...sib, deleted: true, updatedAt: now }); tombstones++; }
    else dropped++;
  }
}

copyFileSync(dbPath, dbPath.replace(/\.json$/, `.backup-${now}.json`));
writeFileSync(dbPath, JSON.stringify(out), 'utf-8');

console.log(`Migration complete → ${dbPath}`);
console.log(`  recurring masters:      ${masters}`);
console.log(`  non-repeating events:   ${singles}`);
console.log(`  tombstones (to delete): ${tombstones}`);
console.log(`  dropped bookkeeping:    ${dropped}`);
console.log(`  total records written:  ${Object.keys(out).length}`);
console.log(`  backup: ${dbPath.replace(/\.json$/, `.backup-${now}.json`)}`);
