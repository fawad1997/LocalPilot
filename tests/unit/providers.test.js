import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenAIProvider, AnthropicProvider, ProviderError, parseArgs, extractTextToolCalls, retryDelayMs, modelInfo } from '../../src/providers.js';

test('retry classification and delays', async () => {
  assert.equal(new ProviderError('x', { status: 502 }).retryable, true);
  assert.equal(new ProviderError('x', { status: 429 }).retryable, true);
  assert.equal(new ProviderError('x', { status: 400 }).retryable, false);
  assert.equal(new ProviderError('x', { status: 401 }).retryable, false);
  assert.equal(new ProviderError('network').retryable, true);
  assert.equal(retryDelayMs({ retryAfterMs: 1000 }, 3), 1000);
  const d1 = retryDelayMs({}, 1);
  const d4 = retryDelayMs({}, 4);
  assert.ok(d1 >= 1500 && d1 <= 2500, `attempt 1 ≈ 2s, got ${d1}`);
  assert.ok(d4 >= 12000 && d4 <= 20000, `attempt 4 ≈ 16s, got ${d4}`);
  assert.ok(retryDelayMs({}, 10) <= 37500, 'capped');

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":"busy"}', { status: 503, headers: { 'retry-after': '7' } });
  try {
    await new OpenAIProvider(settings).complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] });
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.status, 503);
    assert.equal(err.retryable, true);
    assert.equal(err.retryAfterMs, 7000);
  } finally {
    globalThis.fetch = realFetch;
  }
});

const settings = { provider: 'openai', baseUrl: 'http://x/v1', model: 'm', maxTokens: 10, temperature: 0, sendScreenshots: true };

const history = [
  { role: 'user', content: [{ type: 'text', text: 'go' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 't1', name: 'computer', input: { action: 'screenshot' } }] },
  {
    role: 'user',
    content: [{ type: 'tool_result', toolUseId: 't1', isError: false, content: [{ type: 'text', text: 'shot' }, { type: 'image', mediaType: 'image/jpeg', data: 'AAAA' }] }],
  },
];

test('openai wire: tool calls, tool messages, images follow as user message', () => {
  const wire = new OpenAIProvider(settings).toWire('SYS', history);
  assert.equal(wire[0].role, 'system');
  assert.equal(wire[2].tool_calls[0].function.name, 'computer');
  assert.equal(wire[2].tool_calls[0].function.arguments, '{"action":"screenshot"}');
  assert.deepEqual(wire[3], { role: 'tool', tool_call_id: 't1', content: 'shot' });
  assert.equal(wire[4].role, 'user');
  assert.equal(wire[4].content[1].image_url.url, 'data:image/jpeg;base64,AAAA');
});

test('openai wire: screenshots omitted when disabled', () => {
  const wire = new OpenAIProvider({ ...settings, sendScreenshots: false }).toWire('SYS', history);
  assert.equal(wire.length, 4);
});

test('anthropic wire maps blocks', () => {
  const p = new AnthropicProvider({ ...settings, provider: 'anthropic' });
  const block = p.toWireBlock(history[2].content[0]);
  assert.equal(block.tool_use_id, 't1');
  assert.equal(block.content[1].source.media_type, 'image/jpeg');
  assert.equal(p.url('/v1/messages'), 'http://x/v1/messages');
});

test('parseArgs tolerates fences, single quotes, trailing commas', () => {
  assert.deepEqual(parseArgs('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(parseArgs("{'a': 'b',}"), { a: 'b' });
  assert.deepEqual(parseArgs(''), {});
});

test('extractTextToolCalls reads Hermes-style tool calls', () => {
  const { calls, remaining } = extractTextToolCalls('Let me look.\n<tool_call>{"name":"read_page","arguments":{"filter":"interactive"}}</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read_page');
  assert.deepEqual(calls[0].input, { filter: 'interactive' });
  assert.equal(remaining, 'Let me look.');
});

test('openai complete retries without images when the model rejects them', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const hasImage = body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
    if (hasImage) return new Response('{"error":"image input not supported"}', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'fine' } }] }));
  };
  try {
    const provider = new OpenAIProvider(settings);
    const res = await provider.complete({ system: 's', messages: history, tools: [] });
    assert.equal(bodies.length, 2);
    assert.equal(res.content[0].text, 'fine');
    assert.equal(provider.noVision, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('openai complete parses native tool calls and strips <think>', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({
      choices: [{ message: { content: '<think>hmm</think>Clicking.', tool_calls: [{ id: 'c1', function: { name: 'find', arguments: '{"query":"Submit"}' } }] } }],
    }));
  try {
    const res = await new OpenAIProvider(settings).complete({ system: 's', messages: history, tools: [] });
    assert.equal(res.stopReason, 'tool_use');
    assert.deepEqual(res.content[0], { type: 'text', text: 'Clicking.' });
    assert.deepEqual(res.content[1].input, { query: 'Submit' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('openai complete streams SSE: text deltas, split tool-call arguments, usage', async () => {
  const realFetch = globalThis.fetch;
  const enc = new TextEncoder();
  const lines = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: 'Look' } }] },
    { choices: [{ index: 0, delta: { content: 'ing <think>x</think>now' } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'find', arguments: '{"que' } }] } }] },
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"Submit"}' } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 1234, completion_tokens: 5 } },
  ];
  const raw = `${lines.map((l) => `data: ${JSON.stringify(l)}\n\n`).join('')}data: [DONE]\n\n`;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = JSON.parse(init.body);
    // Deliver in odd-sized pieces so events are split across reads.
    const body = new ReadableStream({
      start(c) {
        for (let i = 0; i < raw.length; i += 37) c.enqueue(enc.encode(raw.slice(i, i + 37)));
        c.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const deltas = [];
    const res = await new OpenAIProvider({ ...settings, streaming: true }).complete({
      system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [{ name: 'find', description: 'd', input_schema: { type: 'object' } }], onDelta: (t) => deltas.push(t),
    });
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.equal(deltas.join(''), 'Looking <think>x</think>now');
    assert.equal(res.content[0].text, 'Looking now');
    assert.deepEqual(res.content[1], { type: 'tool_use', id: 'c1', name: 'find', input: { query: 'Submit' } });
    assert.equal(res.usage.prompt_tokens, 1234);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('openai complete falls back to non-streaming when the server rejects stream', async () => {
  const realFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const b = JSON.parse(init.body);
    bodies.push(b);
    if (b.stream) return new Response('{"error":{"message":"stream not supported"}}', { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const p = new OpenAIProvider({ ...settings, streaming: true });
    const args = { system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [], onDelta: () => {} };
    assert.equal((await p.complete(args)).content[0].text, 'ok');
    assert.equal((await p.complete(args)).content[0].text, 'ok');
    assert.deepEqual(bodies.map((b) => b.stream), [true, false, false], 'remembers that streaming is unsupported');
    assert.equal(bodies[0].tools, undefined, 'no empty tools array is sent');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a model the server lists but will not serve gets a clear message', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"message":"Model \'claude-opus-4-5\' is not in the catalog.","code":"model_not_found"}}', { status: 404 });
  try {
    const p = new OpenAIProvider({ ...settings, model: 'claude-opus-4-5', streaming: false });
    await assert.rejects(
      p.complete({ system: 's', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], tools: [] }),
      (err) => err.status === 404 && !err.retryable && /does not accept model "claude-opus-4-5"/.test(err.message) && /Anthropic-compatible/.test(err.message),
    );
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('modelInfo keeps the server name and flags unusable models', () => {
  assert.deepEqual(modelInfo([
    { id: 'auto', name: 'Auto' },
    { id: 'claude-opus-4-5', name: 'Opus slot (routed to gemini-flash)', available: true },
    { id: 'gemini-flash', name: 'Gemini Flash', execution_status: 'exhausted' },
    { id: 'x', name: 'x', available: false, unavailable_reason: 'no key' },
    { id: 'plain' },
  ]), [
    { id: 'auto', name: 'Auto', note: '' },
    { id: 'claude-opus-4-5', name: 'Opus slot (routed to gemini-flash)', note: '' },
    { id: 'gemini-flash', name: 'Gemini Flash', note: 'exhausted' },
    { id: 'x', name: '', note: 'no key' },
    { id: 'plain', name: '', note: '' },
  ]);
});
