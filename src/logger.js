// Structured diagnostics for later analysis (by you or an AI).
// Events are JSON lines written by the native host to <extension>/logs/localpilot-YYYY-MM-DD.jsonl.
// Without the host they wait in chrome.storage.local (last 1000) and are flushed once it is back.
// Never logged: API keys, screenshot pixels. Long strings are truncated.
import * as pc from './pcbridge.js';

const MAX_STRING = 2000;
const MAX_BUFFERED = 1000;
const FLUSH_MS = 1500;
const STORE_KEY = 'logBuffer';

let queue = [];
let timer = null;
let enabled = true;
let flushing = false;

chrome.storage.local.get('settings').then(({ settings }) => {
  enabled = settings?.logging !== false;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.settings) enabled = changes.settings.newValue?.logging !== false;
});

export function sanitize(value, depth = 0) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}… (${value.length} chars)` : value;
  if (depth > 6) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (typeof value === 'object') {
    if (value.type === 'image' && typeof value.data === 'string') return { type: 'image', mediaType: value.mediaType, base64Chars: value.data.length };
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/api[-_]?key|authorization|token|password/i.test(k)) out[k] = '[redacted]';
      else out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

export function log(type, data = {}) {
  if (!enabled) return;
  queue.push({ ts: new Date().toISOString(), type, ...sanitize(data) });
  if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

export async function flush() {
  timer = null;
  if (flushing || !queue.length) return;
  flushing = true;
  const batch = queue;
  queue = [];
  try {
    const stored = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || [];
    const lines = [...stored, ...batch].map((e) => JSON.stringify(e));
    await pc.call('append_log', { lines }, 10000);
    if (stored.length) await chrome.storage.local.remove(STORE_KEY);
  } catch {
    // Host missing: keep the newest events locally until it is available.
    const stored = (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || [];
    await chrome.storage.local.set({ [STORE_KEY]: [...stored, ...batch].slice(-MAX_BUFFERED) });
  } finally {
    flushing = false;
    if (queue.length && !timer) timer = setTimeout(flush, FLUSH_MS);
  }
}

export async function bufferedEvents() {
  return (await chrome.storage.local.get(STORE_KEY))[STORE_KEY] || [];
}
