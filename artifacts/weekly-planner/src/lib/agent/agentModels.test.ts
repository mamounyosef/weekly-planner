// Tests for the assistant's model catalogue and thinking controls (src/lib/agent/agentModels.ts).
// Run with: npx tsx src/lib/agent/agentModels.test.ts

import assert from 'node:assert/strict';

import {
  MODELS, DEFAULT_MODEL, VISION_MODEL, PROVIDER_LABEL, THINK_BUDGETS, THINK_ORDER, THINK_LABEL, THINK_SHORT, THINK_HINT,
  isKnownModel, isFreeModel, modelInfo, providerOf, costOf,
  canStopThinking, coerceThinkBook, coerceThinkSetting, fmtBudget, lightestLevel, nearestLevel, resolveThink, startLevel,
  thinkDepth, thinkFields, thinkSummary, thinkValue,
  fmtCtx, fmtTokens, fmtDate, fmtPrice, fmtMoney, paramsLabel, priceLabel,
  type ThinkLevel,
} from './agentModels';

const size = (s: string) => Number(s.replace(/[^0-9.]/g, ''));

console.log('--- 1. THE SAME CATALOGUE AS THE NOTES APP ---');
{
  assert.deepEqual(MODELS.map(m => m.id), [
    'nemotron-3-ultra', 'nvidia/nemotron-3-ultra-550b-a55b:free', 'beam', 'minimax/minimax-m3.1-flash:free',
    'dots-studio/dots-3-note-preview:free', 'nvidia/nemotron-3.5-super-vl:free', 'nemotron-3-super',
    'nvidia/nemotron-3-super-120b-a12b:free', 'poolside/laguna-s-2.1:free', 'gpt-oss:120b', 'gemma4:31b',
    'google/gemma-4-31b-it:free', 'xingchen-agi/xing4.0-29b-a4b:free', 'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-lightning:free', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'nemotron-3-nano:30b', 'gpt-oss:20b',
  ]);
  assert.equal(new Set(MODELS.map(m => m.id)).size, MODELS.length, 'no duplicates');
  // Strongest first overall: the top of the list is the largest.
  assert.ok(MODELS.every(m => size(m.params) <= size(MODELS[0].params)));
  for (const m of MODELS) {
    assert.ok(m.name && m.params && m.context > 0, m.id);
    assert.match(m.released, /^\d{4}-\d{2}-\d{2}$/, m.id);
    assert.ok(m.arch.length > 0, `${m.id} has architecture facts`);
    if (m.active) assert.ok(size(m.active) < size(m.params), `${m.id} active < total`);
    if (m.price) assert.ok(m.price.input >= 0 && m.price.output >= 0, m.id);
    for (const s of [m.name, m.note ?? '', ...m.arch]) assert.doesNotMatch(s, /[–—]/, `no dashes in ${m.id}`);
    // Every OpenRouter model has a slash in its id and is free; every Ollama model has none.
    assert.equal(m.provider === 'openrouter', m.id.includes('/'), m.id);
    if (m.provider === 'openrouter') assert.ok(isFreeModel(m), `${m.id} is free`);
    else assert.ok(!isFreeModel(m), `${m.id} is not free`);
    assert.equal(providerOf(m.id), m.provider);
  }
  assert.equal(MODELS.filter(m => m.provider === 'ollama').length, 7, 'the seven Ollama models stay');
  assert.ok(isKnownModel(DEFAULT_MODEL));
  assert.equal(modelInfo(DEFAULT_MODEL).provider, 'ollama', 'the default runs on the .env key');
  assert.ok(modelInfo(VISION_MODEL).vision, 'the image reader can see');
  assert.equal(modelInfo(VISION_MODEL).provider, 'ollama', 'the image reader has no daily cap');
  assert.equal(PROVIDER_LABEL.ollama, 'Ollama');
  assert.equal(PROVIDER_LABEL.openrouter, 'OpenRouter');
  console.log('  ok');
}

console.log('--- 2. THE DETAILS ---');
{
  const ultra = modelInfo('nemotron-3-ultra');
  assert.equal(paramsLabel(ultra), 'MoE, 550B total, 55B active');
  assert.equal(fmtCtx(ultra.context), '256K');
  assert.equal(fmtDate(ultra.released), 'Jun 4, 2026');
  assert.equal(priceLabel(ultra), '$0.10 in · $3.00 out / 1M');
  const beam = modelInfo('beam');
  assert.equal(fmtCtx(beam.context), '1M');
  assert.equal(priceLabel(beam), 'Price not listed');
  assert.equal(paramsLabel(modelInfo('gemma4:31b')), 'Dense, 32.7B');
  assert.equal(priceLabel(modelInfo('nemotron-3-super')), '$0.015 in · $0.60 out / 1M');
  assert.equal(priceLabel(modelInfo('nvidia/nemotron-3-ultra-550b-a55b:free')), 'Free · 50 requests a day');
  assert.equal(fmtCtx(modelInfo('nvidia/nemotron-3-ultra-550b-a55b:free').context), '1M');
  console.log('  ok');
}

console.log('--- 3. UNKNOWN NAMES ARE NEVER TRUSTED ---');
{
  for (const bad of [undefined, null, '', 'gpt-4', 42, {}, 'gemma4:31B', 'google/gemma-4-31b-it']) assert.equal(isKnownModel(bad), false, String(bad));
  const u = modelInfo('mystery');
  assert.equal(u.vision, false);
  assert.equal(u.price, null);
  assert.equal(u.provider, 'ollama');
  assert.equal(modelInfo('someone/model:free').provider, 'openrouter');
  assert.deepEqual(u.think.levels, ['off', 'on']);
  assert.equal(modelInfo(undefined).name, 'Unknown model');
  console.log('  ok');
}

console.log('--- 4. EACH MODEL\'S THINKING LEVELS, AS ITS SERVICE TAKES THEM ---');
{
  const spec = (id: string) => modelInfo(id).think;
  assert.deepEqual(spec('beam'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'max' });
  assert.deepEqual(spec('gpt-oss:120b'), { levels: ['low', 'medium', 'high'], default: 'medium' });
  assert.deepEqual(spec('gpt-oss:20b'), { levels: ['low', 'medium', 'high'], default: 'medium' });
  assert.deepEqual(spec('gemma4:31b'), { levels: ['off', 'on'], default: 'off' });
  assert.deepEqual(spec('nemotron-3-ultra'), { levels: ['off', 'on'], default: 'on' });
  assert.deepEqual(spec('nvidia/nemotron-3-ultra-550b-a55b:free'), { levels: ['off', 'medium', 'high'], default: 'high', budget: true });
  assert.deepEqual(spec('nvidia/nemotron-3-super-120b-a12b:free'), { levels: ['off', 'low', 'medium'], default: 'medium', budget: true });
  assert.deepEqual(spec('dots-studio/dots-3-note-preview:free'), { levels: ['off', 'on'] });
  for (const m of MODELS) {
    const lv = m.think.levels;
    assert.ok(lv.length >= 2, `${m.id} has a choice`);
    // Lightest first, in the one order.
    for (let i = 1; i < lv.length; i++) assert.ok(THINK_ORDER.indexOf(lv[i - 1]) < THINK_ORDER.indexOf(lv[i]), `${m.id} order`);
    if (m.think.default) assert.ok(lv.includes(m.think.default), `${m.id} default is one of its levels`);
    // Budgets are an OpenRouter thing: Ollama takes no numbers.
    if (m.think.budget) assert.equal(m.provider, 'openrouter', m.id);
    // An "on" switch never sits beside named levels.
    if (lv.includes('on')) assert.deepEqual(lv.filter(l => l !== 'off'), ['on'], m.id);
  }
  assert.equal(canStopThinking(spec('beam')), false);
  assert.equal(canStopThinking(spec('minimax/minimax-m3.1-flash:free')), false);
  assert.equal(canStopThinking(spec('gemma4:31b')), true);
  for (const l of THINK_ORDER) assert.ok(THINK_LABEL[l] && THINK_SHORT[l] && THINK_HINT[l], l);
  for (const s of [...Object.values(THINK_LABEL), ...Object.values(THINK_HINT)]) assert.doesNotMatch(s, /[–—]/);
  console.log('  ok');
}

console.log('--- 5. NEAREST LEVEL, START LEVEL, LIGHTEST ---');
{
  const beam = modelInfo('beam').think;
  assert.equal(nearestLevel(beam, 'max'), 'max');
  assert.equal(nearestLevel(beam, 'off'), 'low', 'off becomes the lightest it takes');
  assert.equal(nearestLevel(beam, 'minimal'), 'low');
  // "on" sits between low and medium: a tie goes to the lighter one.
  assert.equal(nearestLevel(modelInfo('gpt-oss:20b').think, 'on'), 'low');
  assert.equal(nearestLevel(modelInfo('gemma4:31b').think, 'high'), 'on');
  assert.equal(nearestLevel(modelInfo('gemma4:31b').think, 'minimal'), 'off');
  assert.equal(startLevel('beam'), 'max', 'the service default when it thinks by default');
  assert.equal(startLevel('gpt-oss:120b'), 'medium');
  assert.equal(startLevel('gemma4:31b'), 'on', 'a model that does not think by default still starts thinking');
  assert.equal(startLevel('dots-studio/dots-3-note-preview:free'), 'on', 'no stated default: on');
  assert.equal(startLevel('nvidia/nemotron-3-ultra-550b-a55b:free'), 'high');
  assert.equal(lightestLevel('beam'), 'low');
  assert.equal(lightestLevel('gemma4:31b'), 'off');
  for (const m of MODELS) assert.ok(m.think.levels.includes(startLevel(m.id)), `${m.id} starts on a level it takes`);
  console.log('  ok');
}

console.log('--- 6. A SAVED PICK IS CHECKED AGAINST THE MODEL ---');
{
  assert.deepEqual(resolveThink('beam', null), { level: 'max' });
  assert.deepEqual(resolveThink('beam', { level: 'off' }), { level: 'low' }, 'Beam cannot stop thinking');
  assert.deepEqual(resolveThink('gemma4:31b', { level: 'xhigh' }), { level: 'on' });
  assert.deepEqual(resolveThink('gemma4:31b', { level: 'off' }), { level: 'off' });
  // Budgets only where the model takes one, never with thinking off, capped at the top stop.
  assert.deepEqual(resolveThink('nvidia/nemotron-3-super-120b-a12b:free', { level: 'low', budget: 4096 }), { level: 'low', budget: 4096 });
  assert.deepEqual(resolveThink('nvidia/nemotron-3-super-120b-a12b:free', { level: 'off', budget: 4096 }), { level: 'off' });
  assert.deepEqual(resolveThink('gemma4:31b', { level: 'on', budget: 4096 }), { level: 'on' }, 'Ollama takes no budget');
  assert.deepEqual(resolveThink('nvidia/nemotron-3-super-120b-a12b:free', { level: 'low', budget: 1e9 }), { level: 'low', budget: 32768 });
  for (const bad of [-5, 0, NaN, Infinity, '4096x' as any]) {
    assert.deepEqual(resolveThink('nvidia/nemotron-3-super-120b-a12b:free', { level: 'low', budget: bad }), { level: 'low' }, String(bad));
  }
  // Junk levels fall back to where the model starts.
  assert.deepEqual(resolveThink('gpt-oss:20b', { level: 'turbo' as ThinkLevel }), { level: 'medium' });
  assert.deepEqual(resolveThink('gpt-oss:20b', { level: undefined }), { level: 'medium' });
  // Every level on every model resolves to one it takes.
  for (const m of MODELS) for (const l of THINK_ORDER) assert.ok(m.think.levels.includes(resolveThink(m.id, { level: l }).level), `${m.id} ${l}`);
  console.log('  ok');
}

console.log('--- 7. WHAT GOES OVER THE WIRE ---');
{
  // Ollama: think = false, true or the level name. Never a budget.
  assert.deepEqual(thinkFields('gemma4:31b', { level: 'off' }), { think: false });
  assert.deepEqual(thinkFields('gemma4:31b', { level: 'on' }), { think: true });
  assert.deepEqual(thinkFields('beam', { level: 'xhigh' }), { think: 'xhigh' });
  assert.deepEqual(thinkFields('beam', { level: 'off' }), { think: 'low' });
  assert.deepEqual(thinkFields('gpt-oss:120b', null), { think: 'medium' });
  // OpenRouter: the reasoning object.
  const sup = 'nvidia/nemotron-3-super-120b-a12b:free';
  assert.deepEqual(thinkFields(sup, { level: 'off' }), { reasoning: { effort: 'none' } }, 'models with efforts switch off with effort none');
  assert.deepEqual(thinkFields('dots-studio/dots-3-note-preview:free', { level: 'off' }), { reasoning: { enabled: false } });
  assert.deepEqual(thinkFields('dots-studio/dots-3-note-preview:free', { level: 'on' }), { reasoning: { enabled: true } });
  assert.deepEqual(thinkFields(sup, { level: 'low' }), { reasoning: { effort: 'low' } });
  assert.deepEqual(thinkFields(sup, { level: 'medium', budget: 8192 }), { reasoning: { max_tokens: 8192 }, think: 'medium' }, 'a budget replaces the effort; the level rides along as the fallback');
  assert.deepEqual(thinkFields('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', { level: 'on', budget: 2048 }), { reasoning: { max_tokens: 2048 }, think: true });
  assert.deepEqual(thinkFields('minimax/minimax-m3.1-flash:free', { level: 'off' }), { reasoning: { effort: 'low' } }, 'always thinks: off is its lightest');
  // Voice mode's plain switch.
  assert.deepEqual(thinkValue('gemma4:31b', false), { think: false });
  assert.deepEqual(thinkValue('gemma4:31b', true), { think: true });
  assert.deepEqual(thinkValue('gpt-oss:20b', false), { think: 'low' });
  assert.deepEqual(thinkValue('gpt-oss:20b', true), { think: 'medium' });
  assert.deepEqual(thinkValue('beam', false), { think: 'low' });
  assert.deepEqual(thinkValue(sup, false), { reasoning: { effort: 'none' } });
  console.log('  ok');
}

console.log('--- 8. PICKS FROM A DEVICE ARE UNTRUSTED ---');
{
  assert.equal(coerceThinkSetting(undefined), undefined);
  assert.equal(coerceThinkSetting('high'), undefined);
  assert.equal(coerceThinkSetting({ level: 'warp' }), undefined);
  assert.equal(coerceThinkSetting([]), undefined);
  assert.deepEqual(coerceThinkSetting({ level: 'high' }), { level: 'high' });
  assert.deepEqual(coerceThinkSetting({ level: 'high', budget: '2048' }), { level: 'high', budget: 2048 });
  assert.deepEqual(coerceThinkSetting({ level: 'high', budget: -1 }), { level: 'high' });
  assert.deepEqual(coerceThinkSetting({ level: 'high', budget: 2048.6, extra: 1 }), { level: 'high', budget: 2049 });
  assert.deepEqual(coerceThinkBook(null), {});
  assert.deepEqual(coerceThinkBook([1, 2]), {});
  assert.deepEqual(coerceThinkBook({ beam: { level: 'xhigh' }, 'gpt-4': { level: 'high' }, gemma4: 'on', 'gemma4:31b': { level: 'nope' } }), { beam: { level: 'xhigh' } });
  console.log('  ok');
}

console.log('--- 9. LABELS FOR THE CARDS AND THE CHIP ---');
{
  assert.equal(thinkSummary(modelInfo('gemma4:31b').think), 'Off or on');
  assert.equal(thinkSummary(modelInfo('beam').think), 'Low to Max');
  assert.equal(thinkSummary(modelInfo('nvidia/nemotron-3-super-120b-a12b:free').think), 'Off, Low to Medium');
  assert.equal(fmtBudget(1024), '1K');
  assert.equal(fmtBudget(32768), '32K');
  assert.equal(fmtBudget(500), '500');
  assert.deepEqual(THINK_BUDGETS, [1024, 2048, 4096, 8192, 16384, 32768]);
  assert.deepEqual(THINK_ORDER.map(thinkDepth), [0, 1, 1, 2, 2, 3, 4, 4]);
  console.log('  ok');
}

console.log('--- 10. COST ---');
{
  assert.equal(costOf('nemotron-3-ultra', { prompt: 1e6, output: 1e6 }), 3.1);
  assert.ok(Math.abs(costOf('gpt-oss:120b', { prompt: 1e6, output: 0, cached: 1e6 })! - 0.014) < 1e-12);
  assert.ok(Math.abs(costOf('gpt-oss:120b', { prompt: 1e6, output: 0, cached: 5e6 })! - 0.014) < 1e-12);
  assert.ok(Math.abs(costOf('nemotron-3-nano:30b', { prompt: 1e6, output: 0, cached: 1e6 })! - 0.06) < 1e-12);
  assert.equal(costOf('beam', { prompt: 100, output: 100 }), null);
  assert.equal(costOf('gemma4:31b', { prompt: -5, output: -5 }), 0);
  assert.equal(costOf('google/gemma-4-31b-it:free', { prompt: 1e6, output: 1e6 }), 0, 'free models cost nothing');
  console.log('  ok');
}

console.log('--- 11. FORMATTING ---');
{
  assert.equal(fmtCtx(131_072), '128K');
  assert.equal(fmtCtx(1_048_576), '1M');
  assert.equal(fmtCtx(1_000_000), '1M');
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
