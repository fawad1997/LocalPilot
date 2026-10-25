// Page questions without filling the agent's context:
//   extract      - a helper model (settings.helperModel, else the main model) answers a question
//                  from the page text, part by part, optionally as JSON of a given schema.
//   search_page  - finds lines in the page text (words or a regex) with context. No model call.
// And the check after a task (judgeRun): did the run do what the user asked?
import { createProvider } from './providers.js';

const text = (t) => ({ type: 'text', text: t });
const CHUNK_CHARS = 12000;
const MAX_CHUNKS = 6;
const HELPER_TIMEOUT_MS = 120000;

export const EXTRACT_DEF = {
  name: 'extract',
  description:
    'Answer a question from the current page text without reading it all yourself: a helper model reads the page (long pages part by part) and answers. ' +
    'Give schema (a JSON schema) to get structured data back, e.g. all products with name and price. Answers come only from the page.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to find, e.g. "the email address of Dr. X" or "every job title and salary".' },
      schema: { type: 'object', description: 'Optional JSON schema for the answer.' },
    },
    required: ['query'],
  },
};

export const SEARCH_PAGE_DEF = {
  name: 'search_page',
  description: 'Find words (or a regex) in the current page text and get the matching lines with context. Fast and free: no model call. Use it to locate emails, prices, names.',
  input_schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      regex: { type: 'boolean', description: 'Treat pattern as a regular expression (default: plain words, any case).' },
      context: { type: 'number', description: 'Lines before and after each match (default 1).' },
      max_results: { type: 'number', description: 'Default 20.' },
    },
    required: ['pattern'],
  },
};

export function helperProvider(settings) {
  return createProvider({ ...settings, model: settings.helperModel || settings.model, streaming: false });
}

async function ask(provider, system, prompt, responseFormat) {
  const signal = AbortSignal.timeout(HELPER_TIMEOUT_MS);
  const res = await provider.complete({ system, messages: [{ role: 'user', content: [text(prompt)] }], tools: [], signal, responseFormat });
  return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

export function chunkText(body, size = CHUNK_CHARS) {
  const chunks = [];
  let rest = body;
  while (rest.length) {
    let cut = rest.length <= size ? rest.length : rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = Math.min(size, rest.length);
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  return chunks;
}

function parseJson(s) {
  const m = String(s).replace(/^```(?:json)?|```$/g, '').trim();
  try {
    return JSON.parse(m);
  } catch {
    const a = m.indexOf('{') >= 0 && (m.indexOf('[') < 0 || m.indexOf('{') < m.indexOf('[')) ? [m.indexOf('{'), m.lastIndexOf('}')] : [m.indexOf('['), m.lastIndexOf(']')];
    return a[0] >= 0 ? JSON.parse(m.slice(a[0], a[1] + 1)) : null;
  }
}

// Answers from several parts of a page, joined: arrays are concatenated without repeats, other
// values are kept from the first part that had them.
export function mergeParts(parts) {
  if (parts.length === 1) return parts[0];
  if (parts.every((p) => Array.isArray(p))) {
    const seen = new Set();
    return parts.flat().filter((x) => {
      const k = JSON.stringify(x);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }
  if (parts.every((p) => p && typeof p === 'object' && !Array.isArray(p))) {
    const out = {};
    for (const p of parts) {
      for (const [k, v] of Object.entries(p)) {
        if (Array.isArray(v) && Array.isArray(out[k])) out[k] = mergeParts([out[k], v]);
        else if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
      }
    }
    return out;
  }
  return parts[0];
}

export async function extract(settings, page, input) {
  const query = String(input.query || '').trim();
  if (!query) throw new Error('extract needs a query.');
  const chunks = chunkText(page.text).slice(0, MAX_CHUNKS);
  const provider = helperProvider(settings);
  const system = [
    'You extract information from the text of one web page. Use only that text; never guess or add outside knowledge.',
    input.schema ? 'Reply with JSON matching the given schema. Leave out what is not in the text (empty list, or null).' : 'Reply briefly with the answer, quoting values exactly (emails, prices, names). If the text does not contain it, reply exactly: NOT FOUND',
  ].join('\n');
  const answers = [];
  for (const [i, chunk] of chunks.entries()) {
    const prompt = `Question: ${query}${input.schema ? `\nJSON schema: ${JSON.stringify(input.schema)}` : ''}\n\nPage: ${page.title} (${page.url})${chunks.length > 1 ? `, part ${i + 1} of ${chunks.length}` : ''}\n---\n${chunk}`;
    const reply = await ask(provider, system, prompt, input.schema ? { name: 'extract', schema: input.schema } : undefined);
    if (input.schema) {
      try {
        const value = parseJson(reply);
        if (value !== null) answers.push(value);
      } catch {
        // a part that did not give valid JSON is skipped
      }
    } else if (reply && !/^NOT FOUND\.?$/i.test(reply)) answers.push(reply);
  }
  const more = page.text.length > CHUNK_CHARS * MAX_CHUNKS ? ` Only the first ${MAX_CHUNKS} parts were read; the page is longer.` : '';
  const head = `Extracted from "${page.title}" (${page.url}), ${chunks.length} part(s), by ${settings.helperModel || settings.model}.${more}`;
  if (!answers.length) return [text(`${head}\nNot found on this page.`)];
  return [text(`${head}\n${input.schema ? JSON.stringify(mergeParts(answers), null, 1) : answers.join('\n')}`)];
}

export function searchPage(page, input) {
  const pattern = String(input.pattern || '');
  if (!pattern) throw new Error('search_page needs a pattern.');
  let re;
  try {
    re = input.regex ? new RegExp(pattern, 'i') : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'), 'i');
  } catch (err) {
    throw new Error(`Bad regex: ${err.message}`);
  }
  const ctx = Math.min(Math.max(Math.round(Number(input.context ?? 1)), 0), 5);
  const max = Math.min(Math.max(Math.round(Number(input.max_results) || 20), 1), 100);
  const lines = page.text.split('\n');
  const hits = [];
  let total = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!re.test(lines[i])) continue;
    total += 1;
    if (hits.length >= max) continue;
    const from = Math.max(0, i - ctx);
    const to = Math.min(lines.length, i + ctx + 1);
    hits.push(lines.slice(from, to).map((l, j) => `${from + j + 1 === i + 1 ? '>' : ' '} ${from + j + 1}: ${l.slice(0, 300)}`).join('\n'));
  }
  if (!total) return [text(`No match for "${pattern}" in the page text (${lines.length} lines).`)];
  return [text(`${total} match(es) for "${pattern}" on ${page.url}${total > hits.length ? ` (first ${hits.length})` : ''}:\n${hits.join('\n--\n')}`)];
}

// ---------------------------------------------------------------------------
// The check after a task: a separate model call reads the request, the steps and the final
// answer, and says whether the task was really done.

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['success', 'partial', 'failed'] },
    reason: { type: 'string' },
    blocked_by: { type: 'string', enum: ['none', 'captcha', 'login', 'error', 'other'] },
  },
  required: ['verdict', 'reason', 'blocked_by'],
};

export function runTrace(messages) {
  const lines = [];
  const results = new Map();
  for (const m of messages) for (const b of m.content || []) if (b.type === 'tool_result') results.set(b.toolUseId, b);
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const b of m.content) {
      if (b.type !== 'tool_use') continue;
      const r = results.get(b.id);
      const out = (r?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').replace(/\s+/g, ' ');
      lines.push(`- ${b.name} ${JSON.stringify(b.input).slice(0, 120)} -> ${r?.isError ? 'ERROR ' : ''}${out.slice(0, 160)}`);
    }
  }
  return lines.slice(-40).join('\n');
}

export async function judgeRun(settings, { task, answer, trace, claimedSuccess }) {
  const system = [
    'You check the work of a browser agent. Given the user\'s request, the actions it took (with result previews) and its final answer, decide:',
    '- success: everything asked was done and the answer is supported by what the actions show;',
    '- partial: some of it was done, or the answer is only partly supported;',
    '- failed: not done, wrong, or the answer is not supported by the actions (invented).',
    'Reply with JSON: {"verdict": "...", "reason": "one or two sentences", "blocked_by": "none|captcha|login|error|other"}.',
  ].join('\n');
  const prompt = `User request:\n${task}\n\nActions:\n${trace || '(none)'}\n\nFinal answer${claimedSuccess === false ? ' (the agent itself reported that it did not succeed)' : ''}:\n${answer}`;
  const reply = await ask(helperProvider(settings), system, prompt, { name: 'judge', schema: JUDGE_SCHEMA });
  const v = parseJson(reply) || {};
  const verdict = ['success', 'partial', 'failed'].includes(v.verdict) ? v.verdict : 'failed';
  return { verdict, reason: String(v.reason || reply).slice(0, 400), blockedBy: v.blocked_by || 'none' };
}
