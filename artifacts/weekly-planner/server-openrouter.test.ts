// Tests for the OpenRouter adapter (server-openrouter.ts).
// Run with: npx tsx server-openrouter.test.ts

import assert from 'node:assert/strict';

import { relayStream, toOpenRouter } from './server-openrouter';

function sse(lines: string[], split = 7): Response {
  const text = lines.map(l => `${l}\n`).join('');
  const enc = new TextEncoder().encode(text);
  // Delivered in small pieces, so lines arrive split across reads.
  const stream = new ReadableStream({
    start(c) { for (let i = 0; i < enc.length; i += split) c.enqueue(enc.slice(i, i + split)); c.close(); },
  });
  return new Response(stream, { status: 200 });
}

async function main() {
  console.log('--- 1. OLLAMA-SHAPED REQUESTS BECOME CHAT COMPLETIONS ---');
  {
    const req = toOpenRouter({
      model: 'x/y:free',
      options: { temperature: 0.2 },
      tools: [{ type: 'function', function: { name: 'list_items' } }],
      reasoning: { effort: 'low' },
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'look', images: ['/9j/AAA', 'iVBOR'] },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'list_items', arguments: { from: '2026-10-26' } } }, { function: { name: 'search_items', arguments: '{"q":"gym"}' } }] },
        { role: 'tool', tool_name: 'list_items', content: '[]' },
        { role: 'tool', tool_name: 'search_items', content: '[1]' },
        { role: 'tool', tool_name: 'orphan', content: 'late' },
      ],
    }, true);
    assert.equal(req.model, 'x/y:free');
    assert.equal(req.temperature, 0.2);
    assert.equal(req.stream, true);
    assert.deepEqual(req.usage, { include: true });
    assert.deepEqual(req.reasoning, { effort: 'low' });
    assert.equal(req.tools.length, 1);
    const [sys, user, asst, t1, t2, orphan] = req.messages;
    assert.deepEqual(sys, { role: 'system', content: 'sys' });
    assert.equal(user.content[1].image_url.url, 'data:image/jpeg;base64,/9j/AAA');
    assert.equal(user.content[2].image_url.url, 'data:image/png;base64,iVBOR');
    assert.equal(asst.tool_calls[0].function.arguments, '{"from":"2026-10-26"}', 'object arguments are sent as JSON text');
    assert.equal(asst.tool_calls[1].function.arguments, '{"q":"gym"}');
    assert.equal(t1.tool_call_id, asst.tool_calls[0].id, 'results are matched to their calls in order');
    assert.equal(t2.tool_call_id, asst.tool_calls[1].id);
    assert.equal(orphan.role, 'user', 'a result with no call left becomes a note');
    // The Ollama-style switch, when no reasoning object is given.
    assert.deepEqual(toOpenRouter({ model: 'm', messages: [], think: 'high' }, false).reasoning, { effort: 'high' });
    assert.deepEqual(toOpenRouter({ model: 'm', messages: [], think: false }, false).reasoning, { enabled: false });
    assert.equal(toOpenRouter({ model: 'm', messages: [] }, false).reasoning, undefined);
    assert.equal(toOpenRouter({ model: 'm', messages: [] }, false).usage, undefined);
    console.log('  ok');
  }

  console.log('--- 2. STREAMED REPLIES BECOME OLLAMA CHUNKS ---');
  {
    const chunks: any[] = [];
    let beats = 0;
    await relayStream(sse([
      ': OPENROUTER PROCESSING',
      'data: {"choices":[{"delta":{"reasoning":"hmm"}}]}',
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"list_","arguments":"{\\"fr"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"items","arguments":"om\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"name":"ask_user","arguments":"not json"}}]}}]}',
      'data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":30,"prompt_tokens_details":{"cached_tokens":100}}}',
      'data: [DONE]',
    ]), c => chunks.push(c), () => beats++);
    assert.deepEqual(chunks[0], { message: { thinking: 'hmm' } });
    assert.deepEqual(chunks[1], { message: { content: 'Hi' } });
    assert.deepEqual(chunks[2], { message: { tool_calls: [
      { function: { name: 'list_items', arguments: { from: 1 } } },
      { function: { name: 'ask_user', arguments: 'not json' } },
    ] } }, 'calls arrive whole, arguments parsed when they are JSON');
    assert.deepEqual(chunks[3], { done: true, prompt_eval_count: 120, eval_count: 30, prompt_eval_cached_count: 100 });
    assert.ok(beats > 3, 'every read counts as activity');
    console.log('  ok');
  }

  console.log('--- 3. AN ERROR INSIDE THE STREAM IS THROWN ---');
  {
    const chunks: any[] = [];
    await assert.rejects(relayStream(sse(['data: {"error":{"message":"Insufficient credits"}}']), c => chunks.push(c)), /Insufficient credits/);
    assert.equal(chunks.length, 0);
    // A last line with no newline is still read.
    const tail: any[] = [];
    const enc = new TextEncoder().encode('data: {"choices":[{"delta":{"content":"end"}}]}');
    await relayStream(new Response(new ReadableStream({ start(c) { c.enqueue(enc); c.close(); } })), c => tail.push(c));
    assert.deepEqual(tail[0], { message: { content: 'end' } });
    assert.equal(tail[1].done, true);
    console.log('  ok');
  }

  console.log('\nAll server-openrouter tests passed.');
}

main().catch(err => { console.error(err); process.exit(1); });
