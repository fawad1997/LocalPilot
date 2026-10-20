// Connection to the LocalPilot native host (host/localpilot-host.mjs).
// Requests from the extension carry an `id`; messages the host starts itself
// (MCP tool calls relayed from Claude Code) carry a `type` and go to listeners.
const HOST_NAME = 'com.localpilot.host';
const INSTALL_HINT = 'PC bridge not installed. Run: node host/install.mjs (in the LocalPilot folder), then reload the extension.';

let port = null;
let nextId = 1;
const pending = new Map();
const listeners = new Set();
const disconnectListeners = new Set();
let lastError = null;

export function connect() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);
  lastError = null;
  port.onMessage.addListener((msg) => {
    if (msg && msg.type && msg.id === undefined) {
      for (const fn of listeners) fn(msg);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error));
  });
  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || 'disconnected';
    lastError = /not found|forbidden|Specified native messaging host/i.test(reason) ? INSTALL_HINT : `PC bridge ${reason}`;
    for (const p of pending.values()) p.reject(new Error(lastError));
    pending.clear();
    port = null;
    for (const fn of disconnectListeners) fn(lastError);
  });
  return port;
}

export function onHostMessage(fn) {
  listeners.add(fn);
}

export function onDisconnect(fn) {
  disconnectListeners.add(fn);
}

// Fire-and-forget message to the host (used for MCP results).
export function post(msg) {
  connect().postMessage(msg);
}

export function call(method, params = {}, timeoutMs = 180000) {
  return new Promise((resolve, reject) => {
    let p;
    try {
      p = connect();
    } catch (err) {
      reject(new Error(`${INSTALL_HINT} (${err.message})`));
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`PC bridge timed out on ${method}`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    p.postMessage({ id, method, params });
  });
}

// Returns host info (roots, scripts) or null when the host is unavailable.
export async function probe() {
  try {
    return await call('hello', {}, 5000);
  } catch {
    return null;
  }
}

export function status() {
  return { connected: !!port, lastError };
}
