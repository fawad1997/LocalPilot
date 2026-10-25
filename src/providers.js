// Model adapters. Internal message format (provider-neutral):
//   { role: 'user' | 'assistant', content: Block[] }
//   Block = { type: 'text', text }
//         | { type: 'image', mediaType, data }            // base64, no data: prefix
//         | { type: 'tool_use', id, name, input }          // assistant only
//         | { type: 'tool_result', toolUseId, content: Block[], isError } // user only
// Tool definition: { name, description, input_schema }

// Statuses worth retrying: timeouts, rate limits, and server/gateway failures
// (e.g. a router whose upstream providers all failed returns 502).
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 527, 529]);

export class ProviderError extends Error {
  constructor(message, { status, body, retryable, retryAfterMs } = {}) {
    super(message);
    this.status = status;
    this.body = body;
    this.retryable = retryable ?? (status === undefined || RETRYABLE_STATUS.has(status));
    this.retryAfterMs = retryAfterMs;
  }
}

function parseRetryAfter(value) {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : undefined;
}

// Delay before retry `attempt` (1-based): server hint, else exponential backoff with jitter.
export function retryDelayMs(err, attempt, baseMs = 2000, maxMs = 30000) {
  if (err.retryAfterMs !== undefined) return Math.min(err.retryAfterMs, 60000);
  const exp = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

export function createProvider(settings) {
  if (settings.provider === 'anthropic') return new AnthropicProvider(settings);
  return new OpenAIProvider(settings);
}

// /models entries -> { id, name, note }. note flags models the server says it cannot run now.
export function modelInfo(list) {
  return list.map((m) => {
    const name = m.display_name || m.name || '';
    let note = '';
    if (m.available === false) note = m.unavailable_reason || 'unavailable';
    else if (/exhausted|unavailable|down|disabled/i.test(m.execution_status || '')) note = m.execution_status;
    return { id: m.id, name: name && name !== m.id ? name : '', note };
  });
}

function joinUrl(base, path) {
  return base.replace(/\/+$/, '') + path;
}

// POST that accepts a JSON reply or, when the request asked for `stream: true`, a
// Server-Sent Events stream of OpenAI-style chunks (reassembled into one JSON reply).
async function postJson(url, body, headers, signal, onDelta) {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    if (err.name === 'TimeoutError') throw new ProviderError(`Model request to ${url} timed out.`, { retryable: true });
    throw new ProviderError(
      `Cannot reach ${url} (${err.message}). Is your local server running?`,
      { retryable: true },
    );
  }
  if (res.ok && /text\/event-stream/i.test(res.headers.get('content-type') || '')) {
    try {
      return await readSse(res, onDelta);
    } catch (err) {
      if (err.name === 'AbortError' || err instanceof ProviderError) throw err;
      throw new ProviderError(`Connection dropped while streaming the reply from ${url} (${err.message}).`, { retryable: true });
    }
  }
  let text;
  try {
    text = await res.text();
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ProviderError(`Connection dropped while reading the reply from ${url} (${err.message}).`, { retryable: true });
  }
  if (!res.ok) {
    let hint = '';
    if (res.status === 403 && /11434/.test(url)) {
      hint = ' Ollama blocks extension origins by default: set OLLAMA_ORIGINS=chrome-extension://* and restart Ollama.';
    } else if (res.status === 404 && /model_not_found|not in the catalog|model .*not found|does not exist/i.test(text)) {
      // Some gateways list models (e.g. "claude-*" slots) that only their other API format serves.
      hint = `\n\nThe server does not accept model "${body?.model}" on this endpoint, even if it shows it in the model list. Pick another model in the picker below, or, if this server also speaks the Anthropic format, set "API format" to Anthropic-compatible in Settings.`;
    }
    throw new ProviderError(`HTTP ${res.status} from ${url}: ${text.slice(0, 500)}${hint}`, {
      status: res.status,
      body: text,
      retryAfterMs: parseRetryAfter(res.headers.get('retry-after')),
    });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(`Invalid JSON from ${url}: ${text.slice(0, 300)}`);
  }
}

// Parse an OpenAI chat-completions SSE stream into the non-streaming response shape.
export async function readSse(res, onDelta) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let finish = null;
  let usage;
  const calls = [];
  const handle = (line) => {
    if (!line.startsWith('data:')) return;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let chunk;
    try {
      chunk = JSON.parse(data);
    } catch {
      return;
    }
    if (chunk.error) throw new ProviderError(`Stream error: ${chunk.error.message || JSON.stringify(chunk.error)}`, { retryable: true });
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) return;
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      content += delta.content;
      onDelta?.(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? calls.length;
      calls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) calls[i].id = tc.id;
      if (tc.function?.name && !calls[i].function.name) calls[i].function.name = tc.function.name;
      if (tc.function?.arguments) calls[i].function.arguments += tc.function.arguments;
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      handle(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
    }
  }
  handle(buf.trim());
  return {
    choices: [{ index: 0, message: { role: 'assistant', content, tool_calls: calls.filter(Boolean) }, finish_reason: finish }],
    usage,
  };
}

let idCounter = 0;
function newToolId() {
  idCounter += 1;
  return `call_${Date.now().toString(36)}_${idCounter}`;
}

// Lenient JSON parse for tool arguments produced by small local models.
export function parseArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    const trimmed = String(raw).trim().replace(/^```(?:json)?/, '').replace(/```$/, '').trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      // Single quotes and trailing commas are the common failures.
      const fixed = trimmed.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1');
      return JSON.parse(fixed);
    }
  }
}

// Some local models do not use native tool calling and instead write
// <tool_call>{"name": ..., "arguments": {...}}</tool_call> in plain text (Hermes/Qwen style).
export function extractTextToolCalls(text) {
  const calls = [];
  const re = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = re.exec(text))) {
    try {
      const obj = parseArgs(m[1]);
      if (obj && obj.name) {
        calls.push({ type: 'tool_use', id: newToolId(), name: obj.name, input: parseArgs(obj.arguments ?? obj.parameters ?? {}) });
      }
    } catch {
      // Not valid JSON: leave it as text.
    }
  }
  const remaining = calls.length ? text.replace(re, '').trim() : text;
  return { calls, remaining };
}

// ---------------------------------------------------------------------------
// OpenAI-compatible /chat/completions (Ollama, LM Studio, llama.cpp, vLLM, LiteLLM)

export class OpenAIProvider {
  constructor(settings) {
    this.settings = settings;
  }

  toWire(system, messages) {
    const out = [{ role: 'system', content: system }];
    for (const msg of messages) {
      if (msg.role === 'assistant') {
        const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        const toolUses = msg.content.filter((b) => b.type === 'tool_use');
        const wire = { role: 'assistant', content: text || null };
        if (toolUses.length) {
          wire.tool_calls = toolUses.map((b) => ({
            id: b.id,
            type: 'function',
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          }));
        }
        out.push(wire);
        continue;
      }
      // user turn: tool results become role=tool messages; their images ride in a follow-up user message
      const pendingImages = [];
      const userParts = [];
      for (const b of msg.content) {
        if (b.type === 'tool_result') {
          const text = b.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          const images = b.content.filter((c) => c.type === 'image');
          out.push({
            role: 'tool',
            tool_call_id: b.toolUseId,
            content: (b.isError ? 'ERROR: ' : '') + (text || (images.length ? (this.noVision ? '(screenshot not shown: this model cannot see images; use read_page or get_page_text)' : '(image attached in next message)') : 'ok')),
          });
          pendingImages.push(...images);
        } else if (b.type === 'text') {
          userParts.push({ type: 'text', text: b.text });
        } else if (b.type === 'image') {
          userParts.push(this.noVision ? { type: 'text', text: '(image not shown: this model cannot see images)' } : imagePart(b));
        }
      }
      if (pendingImages.length && this.settings.sendScreenshots && !this.noVision) {
        userParts.unshift({ type: 'text', text: 'Screenshot result from the previous tool call:' });
        userParts.push(...pendingImages.map(imagePart));
      }
      if (userParts.length) {
        const onlyText = userParts.every((p) => p.type === 'text');
        out.push({ role: 'user', content: onlyText ? userParts.map((p) => p.text).join('\n') : userParts });
      }
    }
    return out;
  }

  // onDelta(text) receives reply text as it streams (settings.streaming, default on).
  // responseFormat { name, schema }: ask the server to force a JSON reply of that shape. Servers that
  // reject json_schema are asked for plain json_object, then for nothing (remembered per provider).
  async complete({ system, messages, tools, signal, onDelta, responseFormat }) {
    const s = this.settings;
    const body = {
      model: s.model,
      messages: this.toWire(system, messages),
      max_tokens: s.maxTokens,
      temperature: s.temperature,
      stream: false,
    };
    if (responseFormat && this.jsonFormat !== 'none') {
      body.response_format = this.jsonFormat === 'object'
        ? { type: 'json_object' }
        : { type: 'json_schema', json_schema: { name: responseFormat.name, schema: responseFormat.schema, strict: false } };
    }
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }));
      body.tool_choice = 'auto';
    }
    if (onDelta && s.streaming !== false && !this.noStream) {
      body.stream = true;
      body.stream_options = { include_usage: true };
    }
    const headers = s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};
    const url = joinUrl(s.baseUrl, '/chat/completions');
    const clientError = (err) => err.status >= 400 && err.status < 500 && err.status !== 401 && err.status !== 403 && err.status !== 429;
    let data;
    try {
      data = await postJson(url, body, headers, signal, onDelta);
    } catch (err) {
      const hadImages = body.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url'));
      // A text-only model refused the screenshot. Routers may say so with a 429 ("model lacks vision").
      if (hadImages && !this.noVision && err.status >= 400 && err.status < 500 && /vision|image/i.test(err.message)) {
        this.noVision = true;
        return this.complete({ system, messages, tools, signal, onDelta, responseFormat });
      }
      if (!clientError(err)) throw err;
      if (body.response_format) {
        // The server does not accept this response_format: step down (json_schema -> json_object -> none).
        this.jsonFormat = body.response_format.type === 'json_schema' ? 'object' : 'none';
        return this.complete({ system, messages, tools, signal, onDelta, responseFormat });
      }
      if (body.stream && !hadImages) {
        // Server does not support streaming (or stream_options): ask again without it.
        this.noStream = true;
        delete body.stream_options;
        body.stream = false;
      } else if (hadImages) {
        // Text-only model (or a router that picked one) rejected the screenshot: retry without images.
        this.noVision = true;
        body.messages = this.toWire(system, messages);
      } else {
        throw err;
      }
      data = await postJson(url, body, headers, signal, onDelta);
    }
    const choice = data.choices?.[0];
    if (!choice) throw new ProviderError(`No choices in response: ${JSON.stringify(data).slice(0, 300)}`);
    const msg = choice.message || {};
    const content = [];
    let text = typeof msg.content === 'string' ? msg.content : '';
    // reasoning models served by some local runtimes put chain-of-thought in <think>…</think>
    text = text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const nativeCalls = (msg.tool_calls || []).map((tc) => ({
      type: 'tool_use',
      id: tc.id || newToolId(),
      name: tc.function?.name,
      input: safeArgs(tc.function?.arguments),
    }));
    let calls = nativeCalls;
    if (!calls.length && text) {
      const extracted = extractTextToolCalls(text);
      calls = extracted.calls;
      text = extracted.remaining;
    }
    if (text) content.push({ type: 'text', text });
    content.push(...calls);
    return { content, stopReason: calls.length ? 'tool_use' : 'end_turn', usage: data.usage };
  }

  async fetchModelList() {
    const s = this.settings;
    const headers = s.apiKey ? { authorization: `Bearer ${s.apiKey}` } : {};
    const res = await fetch(joinUrl(s.baseUrl, '/models'), { headers });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status} listing models`);
    return (await res.json()).data || [];
  }

  async listModels() {
    return (await this.fetchModelList()).map((m) => m.id);
  }

  // Ids plus the server's display name and whether it reports the model as usable now.
  async listModelInfo() {
    return modelInfo(await this.fetchModelList());
  }
}

function safeArgs(raw) {
  try {
    return parseArgs(raw);
  } catch {
    return { __unparsed_arguments: String(raw) };
  }
}

function imagePart(b) {
  return { type: 'image_url', image_url: { url: `data:${b.mediaType};base64,${b.data}` } };
}

// ---------------------------------------------------------------------------
// Anthropic-compatible /v1/messages (LiteLLM proxy, local gateways)

export class AnthropicProvider {
  constructor(settings) {
    this.settings = settings;
  }

  url(path) {
    const base = this.settings.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    return base + path;
  }

  toWireBlock(b) {
    switch (b.type) {
      case 'text':
        return { type: 'text', text: b.text };
      case 'image':
        return { type: 'image', source: { type: 'base64', media_type: b.mediaType, data: b.data } };
      case 'tool_use':
        return { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} };
      case 'tool_result':
        return {
          type: 'tool_result',
          tool_use_id: b.toolUseId,
          is_error: !!b.isError,
          content: b.content
            .filter((c) => c.type === 'text' || (c.type === 'image' && this.settings.sendScreenshots))
            .map((c) => this.toWireBlock(c)),
        };
      default:
        return null;
    }
  }

  async complete({ system, messages, tools, signal }) {
    const s = this.settings;
    const body = {
      model: s.model,
      system,
      max_tokens: s.maxTokens,
      temperature: s.temperature,
      tools,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content.map((b) => this.toWireBlock(b)).filter(Boolean),
      })),
    };
    const headers = { 'anthropic-version': '2023-06-01' };
    if (s.apiKey) headers['x-api-key'] = s.apiKey;
    const data = await postJson(this.url('/v1/messages'), body, headers, signal);
    const content = (data.content || [])
      .map((b) => {
        if (b.type === 'text') return { type: 'text', text: b.text };
        if (b.type === 'tool_use') return { type: 'tool_use', id: b.id || newToolId(), name: b.name, input: b.input ?? {} };
        return null;
      })
      .filter(Boolean);
    const hasTools = content.some((b) => b.type === 'tool_use');
    return { content, stopReason: hasTools ? 'tool_use' : data.stop_reason || 'end_turn', usage: data.usage };
  }

  async fetchModelList() {
    const headers = { 'anthropic-version': '2023-06-01' };
    if (this.settings.apiKey) headers['x-api-key'] = this.settings.apiKey;
    const res = await fetch(this.url('/v1/models'), { headers });
    if (!res.ok) throw new ProviderError(`HTTP ${res.status} listing models`);
    return (await res.json()).data || [];
  }

  async listModels() {
    return (await this.fetchModelList()).map((m) => m.id);
  }

  // Ids plus the server's display name and whether it reports the model as usable now.
  async listModelInfo() {
    return modelInfo(await this.fetchModelList());
  }
}
