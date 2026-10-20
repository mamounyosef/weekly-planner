import assert from 'node:assert/strict';
import { ORB_MAX_FRACTION, orbAverageSeconds, orbFraction, quantiseOrbFraction } from './orbRing';

const H = 3600;
const map = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [k, { seconds: v }]));

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  void name;
}

// ── orbAverageSeconds ─────────────────────────────────────────────────────────

test('no history at all is 0', () => {
  assert.equal(orbAverageSeconds(new Map(), '2026-10-20'), 0);
});

test('only today has focus: nothing before it to average', () => {
  assert.equal(orbAverageSeconds(map({ '2026-10-20': 5 * H }), '2026-10-20'), 0);
});

test('today is never part of its own average', () => {
  const t = map({ '2026-10-19': 2 * H, '2026-10-20': 10 * H });
  assert.equal(orbAverageSeconds(t, '2026-10-20'), 2 * H);
});

test('zero days after the first focus count as zero', () => {
  // first focus 2026-10-17 (4h); 18th and 19th empty -> 4h / 3 days
  const t = map({ '2026-10-17': 4 * H });
  assert.equal(orbAverageSeconds(t, '2026-10-20'), Math.round(4 * H / 3));
});

test('days before the first focus ever are not counted', () => {
  const t = map({ '2026-10-18': 3 * H, '2026-10-19': 1 * H });
  assert.equal(orbAverageSeconds(t, '2026-10-20'), 2 * H);
});

test('a full 30-day window averages exactly 30 days', () => {
  const o: Record<string, number> = {};
  for (let i = 1; i <= 40; i += 1) {
    const d = new Date(2026, 9, 20 - i);
    const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    o[k] = i <= 30 ? 2 * H : 100 * H; // days 31..40 are huge and must be ignored
  }
  assert.equal(orbAverageSeconds(map(o), '2026-10-20'), 2 * H);
});

test('excluded days are skipped, not counted as zero', () => {
  const t = map({ '2026-10-17': 3 * H, '2026-10-18': 0, '2026-10-19': 3 * H });
  assert.equal(orbAverageSeconds(t, '2026-10-20', ['2026-10-18']), 3 * H);
  assert.equal(orbAverageSeconds(t, '2026-10-20'), 2 * H);
});

test('every past day excluded gives 0', () => {
  const t = map({ '2026-10-19': 3 * H });
  assert.equal(orbAverageSeconds(t, '2026-10-20', ['2026-10-19']), 0);
});

test('crosses month and year boundaries', () => {
  const t = map({ '2025-12-31': 2 * H, '2026-01-01': 4 * H });
  assert.equal(orbAverageSeconds(t, '2026-01-02'), 3 * H);
  const m = map({ '2026-02-28': 1 * H, '2026-03-01': 3 * H });
  assert.equal(orbAverageSeconds(m, '2026-03-02'), 2 * H);
});

test('leap day is a real day', () => {
  const t = map({ '2028-02-28': 3 * H, '2028-02-29': 0, '2028-03-01': 3 * H });
  assert.equal(orbAverageSeconds(t, '2028-03-02'), 2 * H);
});

test('the window size is respected', () => {
  const t = map({ '2026-10-15': 10 * H, '2026-10-19': 2 * H });
  assert.equal(orbAverageSeconds(t, '2026-10-20', [], 1), 2 * H);
  assert.equal(orbAverageSeconds(t, '2026-10-20', [], 0), 0);
  assert.equal(orbAverageSeconds(t, '2026-10-20', [], -3), 0);
});

test('future days are ignored', () => {
  const t = map({ '2026-10-19': 2 * H, '2026-10-25': 50 * H });
  assert.equal(orbAverageSeconds(t, '2026-10-20'), 2 * H);
});

test('a first focus day in the future does not hide the past', () => {
  // only a future day has focus: nothing in the window
  assert.equal(orbAverageSeconds(map({ '2026-10-25': 5 * H }), '2026-10-20'), 0);
});

test('bad values are ignored, never NaN', () => {
  const t = new Map<string, { seconds: number }>([
    ['2026-10-18', { seconds: 2 * H }],
    ['2026-10-19', { seconds: NaN }],
    ['not-a-date', { seconds: 99 * H }],
    ['2026-10-17', { seconds: -5 }],
  ]);
  const avg = orbAverageSeconds(t, '2026-10-20');
  assert.equal(avg, H); // 18th = 2h, 19th = 0 -> first real focus is the 18th
  assert.ok(Number.isFinite(avg));
});

test('a malformed today gives 0', () => {
  assert.equal(orbAverageSeconds(map({ '2026-10-19': H }), '20-10-2026'), 0);
  assert.equal(orbAverageSeconds(map({ '2026-10-19': H }), ''), 0);
});

// ── orbFraction ──────────────────────────────────────────────────────────────

test('fraction of the average', () => {
  assert.equal(orbFraction(0, 2 * H), 0);
  assert.equal(orbFraction(H, 2 * H), 0.5);
  assert.equal(orbFraction(2 * H, 2 * H), 1);
  assert.equal(orbFraction(3 * H, 2 * H), 1.5);
});

test('capped at two laps', () => {
  assert.equal(orbFraction(10 * H, 2 * H), ORB_MAX_FRACTION);
});

test('no average: the goal stands in', () => {
  assert.equal(orbFraction(H, 0, 4 * H), 0.25);
});

test('no average and no goal: any focus is a full overflow, none is empty', () => {
  assert.equal(orbFraction(60, 0, 0), ORB_MAX_FRACTION);
  assert.equal(orbFraction(0, 0, 0), 0);
});

test('garbage in, 0..2 out', () => {
  assert.equal(orbFraction(NaN, 2 * H), 0);
  assert.equal(orbFraction(-H, 2 * H), 0);
  assert.equal(orbFraction(H, NaN, NaN), ORB_MAX_FRACTION);
  assert.equal(orbFraction(Infinity, 2 * H), 0);
  assert.equal(orbFraction(H, -5, 2 * H), 0.5);
});

// ── quantiseOrbFraction ──────────────────────────────────────────────────────

test('quantised to 1/500 of a lap and clamped', () => {
  assert.equal(quantiseOrbFraction(0.1234), 0.124);
  assert.equal(quantiseOrbFraction(0.0009), 0);
  assert.equal(quantiseOrbFraction(-1), 0);
  assert.equal(quantiseOrbFraction(NaN), 0);
  assert.equal(quantiseOrbFraction(5), ORB_MAX_FRACTION);
  assert.equal(quantiseOrbFraction(1), 1);
});

console.log(`orbRing: ${passed} tests passed`);
