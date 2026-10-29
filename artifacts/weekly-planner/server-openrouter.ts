// ─── OpenRouter, behind the shapes the agent already uses for Ollama ─────────
//
// Requests arrive in Ollama's chat format and are turned into OpenAI-style
// chat completions; streamed replies are turned back into Ollama-shaped
// chunks, so the agent loop does not need to know which service answered.
// The same adapter as the Notes app's (electron/openrouter.ts).

export const OPENROUTER = 'https://openrouter.ai/api/v1';

/** Guesses the image type from its first bytes (base64), for the data URL. */
function mimeOf(b64: string) {
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('R0lG')) return 'image/gif';
  if (b64.startsWith('UklG')) return 'image/webp';
  return 'image/png';
}

/** Ollama messages (images as base64, tool calls without ids) to OpenAI messages. */
function toMessages(messages: any[]) {
  const out: any[] = [];
  // Tool results follow their calls in order, so hand out the call ids the same way.
  let pending: string[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: m.content || '' };
      if (m.tool_calls?.length) {
        pending = m.tool_calls.map((_: any, j: number) => `call_${i}_${j}`);
        msg.tool_calls = m.tool_calls.map((c: any, j: number) => ({
          id: pending[j],
          type: 'function',
          function: { name: c.function?.name, arguments: typeof c.function?.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function?.arguments || {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') {
      const id = pending.shift();
      if (id) out.push({ role: 'tool', tool_call_id: id, content: m.content || '' });
      else out.push({ role: 'user', content: `(Result of ${m.tool_name || 'a tool'}:)\n${m.content || ''}` });
    } else if (Array.isArray(m.images) && m.images.length) {
      out.push({
        role: m.role,
        content: [
          { type: 'text', text: m.content || '' },
          ...m.images.map((b64: string) => ({ type: 'image_url', image_url: { url: `data:${mimeOf(b64)};base64,${b64}` } })),
        ],
      });
    } else out.push({ role: m.role, content: m.content || '' });
  });
  return out;
}

/** The request body for /chat/completions. */
export function toOpenRouter(body: any, stream: boolean) {
  const o = body.options || {};
  const req: any = { model: body.model, messages: toMessages(body.messages || []), stream };
  if (body.tools?.length) req.tools = body.tools;
  if (o.temperature !== undefined) req.temperature = o.temperature;
  if (o.num_predict) req.max_tokens = o.num_predict;
  // The agent sends OpenRouter's own reasoning object (a level, a budget or off); short calls send the Ollama-style switch.
  if (body.reasoning && typeof body.reasoning === 'object') req.reasoning = body.reasoning;
  else if (typeof body.think === 'string') req.reasoning = { effort: body.think };
  else if (body.think !== undefined) req.reasoning = { enabled: Boolean(body.think) };
  if (stream) req.usage = { include: true };
  return req;
}

export function postOpenRouter(key: string, req: any, signal: AbortSignal) {
  return fetch(`${OPENROUTER}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'Daily Planner',
    },
    body: JSON.stringify(req),
    signal,
  });
}

/**
 * Posts, and when a model refuses to switch reasoning off (some always
 * reason), asks again with low reasoning and no token cap, since the
 * reasoning would otherwise eat the cap and leave the answer empty.
 */
export async function postWithFallback(key: string, req: any, signal: AbortSignal) {
  const res = await postOpenRouter(key, req, signal);
  if (res.status !== 400 || (req.reasoning?.enabled !== false && req.reasoning?.effort !== 'none')) return res;
  const text = await res.clone().text().catch(() => '');
  if (!/reasoning/i.test(text)) return res;
  const { max_tokens: _cap, ...rest } = req;
  return postOpenRouter(key, { ...rest, reasoning: { effort: 'low' } }, signal);
}

/** Tool call arguments arrive as a JSON string; the tools take an object. */
function parseArgs(s: string): unknown {
  if (!s) return {};
  try { return JSON.parse(s); } catch { return s; }
}

/**
 * Reads an OpenRouter stream and emits Ollama-shaped chunks:
 * { message: { thinking | content } } while it runs, the tool calls once they
 * are complete, then { done: true, prompt_eval_count, eval_count }.
 * Throws the error text if the stream carries an error.
 */
export async function relayStream(res: Response, emit: (chunk: any) => void, onActivity?: () => void) {
  const calls: { name: string; args: string }[] = [];
  let usage: any = null;
  const reader = (res.body as any).getReader();
  const dec = new TextDecoder();
  let buf = '';
  const handle = (data: string) => {
    if (data === '[DONE]') return;
    let j: any;
    try { j = JSON.parse(data); } catch { return; }
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    if (j.usage) usage = j.usage;
    const d = j.choices?.[0]?.delta;
    if (!d) return;
    if (d.reasoning) emit({ message: { thinking: d.reasoning } });
    if (d.content) emit({ message: { content: d.content } });
    for (const tc of d.tool_calls || []) {
      const at = Number(tc.index ?? calls.length);
      const c = (calls[at] ||= { name: '', args: '' });
      if (tc.function?.name) c.name += tc.function.name;
      if (tc.function?.arguments) c.args += tc.function.arguments;
    }
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    onActivity?.();
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      // Lines starting with ":" are keep-alive comments.
      if (line.startsWith('data:')) handle(line.slice(5).trim());
    }
  }
  if (buf.trim().startsWith('data:')) handle(buf.trim().slice(5).trim());
  const finished = calls.filter(c => c && c.name);
  if (finished.length) emit({ message: { tool_calls: finished.map(c => ({ function: { name: c.name, arguments: parseArgs(c.args) } })) } });
  emit({
    done: true,
    prompt_eval_count: usage?.prompt_tokens || 0,
    eval_count: usage?.completion_tokens || 0,
    prompt_eval_cached_count: usage?.prompt_tokens_details?.cached_tokens || 0,
  });
}
