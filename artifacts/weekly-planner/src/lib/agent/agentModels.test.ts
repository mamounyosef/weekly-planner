// Tests for the assistant's model catalogue (src/lib/agent/agentModels.ts).
// Run with: npx tsx src/lib/agent/agentModels.test.ts

import assert from 'node:assert/strict';

import {
  MODELS, DEFAULT_MODEL, VISION_MODEL, isKnownModel, modelInfo, thinkValue, costOf,
  fmtCtx, fmtTokens, fmtDate, fmtPrice, fmtMoney, paramsLabel, priceLabel,
} from './agentModels';

const size = (s: string) => Number(s.replace(/[^0-9.]/g, ''));

console.log('--- 1. EXACTLY THE OLLAMA MODELS THE KEY COVERS ---');
{
  assert.deepEqual(MODELS.map(m => m.id).sort(), [
    'beam', 'gemma4:31b', 'gpt-oss:120b', 'gpt-oss:20b', 'nemotron-3-nano:30b', 'nemotron-3-super', 'nemotron-3-ultra',
  ].sort());
  assert.equal(new Set(MODELS.map(m => m.id)).size, MODELS.length, 'no duplicates');
  // Strongest first: total parameters never go up down the list.
  for (let i = 1; i < MODELS.length; i++) {
    assert.ok(size(MODELS[i - 1].params) >= size(MODELS[i].params), `${MODELS[i - 1].id} before ${MODELS[i].id}`);
  }
  for (const m of MODELS) {
    assert.ok(m.name && m.params && m.context > 0, m.id);
    assert.match(m.released, /^\d{4}-\d{2}-\d{2}$/, m.id);
    assert.ok(m.arch.length > 0, `${m.id} has architecture facts`);
    if (m.active) assert.ok(size(m.active) < size(m.params), `${m.id} active < total`);
    if (m.price) assert.ok(m.price.input >= 0 && m.price.output >= 0, m.id);
    for (const s of [m.name, m.note ?? '', ...m.arch]) assert.doesNotMatch(s, /[–—]/, `no dashes in ${m.id}`);
  }
  assert.ok(isKnownModel(DEFAULT_MODEL));
  assert.ok(modelInfo(VISION_MODEL).vision, 'the image reader can see');
  console.log('  ok');
}

console.log('--- 2. THE DETAILS MATCH THE NOTES APP ---');
{
  const ultra = modelInfo('nemotron-3-ultra');
  assert.equal(paramsLabel(ultra), 'MoE, 550B total, 55B active');
  assert.equal(fmtCtx(ultra.context), '256K');
  assert.equal(fmtDate(ultra.released), 'Jun 4, 2026');
  assert.equal(priceLabel(ultra), '$0.10 in · $3.00 out / 1M');
  assert.ok(ultra.arch.includes('512 experts + 1 shared, 22 per token'));
  const beam = modelInfo('beam');
  assert.equal(fmtCtx(beam.context), '1M');
  assert.equal(priceLabel(beam), 'Price not listed');
  assert.equal(paramsLabel(modelInfo('gemma4:31b')), 'Dense, 32.7B');
  assert.equal(priceLabel(modelInfo('nemotron-3-super')), '$0.015 in · $0.60 out / 1M');
  console.log('  ok');
}

console.log('--- 3. UNKNOWN NAMES ARE NEVER TRUSTED ---');
{
  for (const bad of [undefined, null, '', 'gpt-4', 42, {}, 'gemma4:31B']) assert.equal(isKnownModel(bad), false, String(bad));
  const u = modelInfo('mystery');
  assert.equal(u.vision, false);
  assert.equal(u.price, null);
  assert.equal(modelInfo(undefined).name, 'Unknown model');
  console.log('  ok');
}

console.log('--- 4. THINKING AND COST ---');
{
  assert.equal(thinkValue('gpt-oss:120b'), 'high');
  assert.equal(thinkValue('gpt-oss:20b'), 'high');
  assert.equal(thinkValue('gemma4:31b'), true);
  assert.equal(thinkValue('beam'), true);
  // 1M prompt + 1M output on Ultra = $0.10 + $3.00.
  assert.equal(costOf('nemotron-3-ultra', { prompt: 1e6, output: 1e6 }), 3.1);
  // Cached prompt tokens use the cached price; more cached than prompt is clamped.
  assert.ok(Math.abs(costOf('gpt-oss:120b', { prompt: 1e6, output: 0, cached: 1e6 })! - 0.014) < 1e-12);
  assert.ok(Math.abs(costOf('gpt-oss:120b', { prompt: 1e6, output: 0, cached: 5e6 })! - 0.014) < 1e-12);
  // A model with no published cached price charges cached tokens at the input price.
  assert.ok(Math.abs(costOf('nemotron-3-nano:30b', { prompt: 1e6, output: 0, cached: 1e6 })! - 0.06) < 1e-12);
  assert.equal(costOf('beam', { prompt: 100, output: 100 }), null);
  assert.equal(costOf('gemma4:31b', { prompt: -5, output: -5 }), 0);
  console.log('  ok');
}

console.log('--- 5. FORMATTING ---');
{
  assert.equal(fmtCtx(131_072), '128K');
  assert.equal(fmtCtx(1_048_576), '1M');
  assert.equal(fmtCtx(0), '?');
  assert.equal(fmtTokens(950), '950');
  assert.equal(fmtTokens(12_345), '12K');
  assert.equal(fmtTokens(1_234), '1.2K');
  assert.equal(fmtTokens(2_500_000), '2.5M');
  assert.equal(fmtTokens(NaN), '0');
  assert.equal(fmtDate('2025-08-05'), 'Aug 5, 2025');
  assert.equal(fmtDate('nope'), '');
  assert.equal(fmtPrice(0.015), '$0.015');
  assert.equal(fmtPrice(3), '$3.00');
  assert.equal(fmtPrice(0), '$0.00');
  assert.equal(fmtPrice(null), '-');
  assert.equal(fmtMoney(0), '$0');
  assert.equal(fmtMoney(0.00001), '<$0.0001');
  assert.equal(fmtMoney(0.0042), '$0.0042');
  assert.equal(fmtMoney(0.031), '$0.031');
  assert.equal(fmtMoney(1.2), '$1.20');
  console.log('  ok');
}

console.log('\nAll agentModels tests passed.');
